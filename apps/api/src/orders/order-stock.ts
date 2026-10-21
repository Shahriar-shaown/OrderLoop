import {
  InsufficientStockError,
  resolveLocation,
  resolveReservation,
  reserveStock,
  returnStock,
} from '@orderloop/catalog';
import type { Tx } from '@orderloop/db';
import { ApiError } from '../common/api-error.js';
import type { StockRunner } from '../inventory/inventory.service.js';

/**
 * The only code that moves stock for an order, and only at the four moments the state machine names (domain
 * `stockEffect`). Each call runs inside the caller's transaction, with the order row already locked, so an order's stock
 * and its status change commit or roll back together.
 *
 * Every movement carries an idempotency key built from the order and the line. The status check already makes each
 * effect happen once; the key is a second barrier, so even a bug that applied an effect twice would hit a unique index
 * and roll back instead of adding or removing stock twice.
 */
export interface StockActor {
  tenantId: string;
  userId: string | null;
}

export interface LineRef {
  id: string;
  variantId: string;
  sku: string;
  quantity: number;
  reservationId: string | null;
}

const meta = (actor: StockActor, orderId: string, key: string, reason?: string) => ({
  createdById: actor.userId,
  referenceType: 'order',
  referenceId: orderId,
  idempotencyKey: key,
  ...(reason ? { reason } : {}),
});

/**
 * Confirming reserves at the default location only. When that is short but the same item is available elsewhere, say so,
 * so the person knows to move the stock (receive it into the default location) instead of believing it is lost.
 */
async function elsewhereNote(
  tx: Tx,
  tenantId: string,
  variantId: string,
  locationId: string,
  needed: number,
): Promise<string> {
  const here = await tx.stockLocation.findFirst({
    where: { id: locationId, tenantId },
    select: { name: true },
  });
  const rows = await tx.$queryRaw<{ name: string; available: number }[]>`
    SELECT l.name, (s.on_hand - s.reserved)::int AS available
    FROM stock_levels s JOIN stock_locations l ON l.tenant_id = s.tenant_id AND l.id = s.location_id
    WHERE s.tenant_id = ${tenantId}::uuid AND s.variant_id = ${variantId}::uuid AND s.location_id <> ${locationId}::uuid
      AND s.on_hand - s.reserved > 0
    ORDER BY l.name`;
  const total = rows.reduce((n, r) => n + r.available, 0);
  if (total < 1) return '';
  const where = rows.map((r) => `${r.available} at ${r.name}`).join(', ');
  return `Orders are filled from the default location (${here?.name ?? 'default'}) only; the rest is elsewhere (${where}).${total >= needed ? ' Move it to the default location, then confirm again.' : ''}`;
}

/** A fixed order (by variant, then line) so two orders touching the same stock at once cannot lock it in opposite directions. */
const inLockOrder = (lines: readonly LineRef[]): LineRef[] =>
  [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId) || a.id.localeCompare(b.id));

/** Reserve every line, or none: any shortage rolls the whole transaction back and names every short line. */
export async function reserveOrder(
  tx: Tx,
  runner: StockRunner,
  actor: StockActor,
  orderId: string,
  lines: readonly LineRef[],
): Promise<Map<string, string>> {
  const ordered = inLockOrder(lines);
  const locationId = await resolveLocation(tx, actor.tenantId);
  const reservations = new Map<string, string>();
  const short: { path: string; message: string }[] = [];
  const index = new Map(lines.map((l, i) => [l.id, i]));
  for (const line of ordered) {
    await runner.requireActiveVariant(tx, actor.tenantId, line.variantId);
    try {
      const r = await reserveStock(
        tx,
        { tenantId: actor.tenantId, variantId: line.variantId, locationId },
        line.quantity,
        meta(actor, orderId, `reserve:${orderId}:${line.id}`),
      );
      reservations.set(line.id, r.reservationId);
    } catch (error) {
      if (!(error instanceof InsufficientStockError)) throw error;
      const note = await elsewhereNote(
        tx,
        actor.tenantId,
        line.variantId,
        locationId,
        error.requested,
      );
      short.push({
        path: `items.${index.get(line.id)}`,
        message: `${line.sku}: only ${error.available} available, ${error.requested} needed${note ? `. ${note}` : ''}`,
      });
    }
  }
  if (short.length)
    throw new ApiError(
      'insufficient_stock',
      `Not enough stock for ${short.length === 1 ? 'one item' : `${short.length} items`}: ${short.map((s) => s.message).join('; ')}`,
      short,
    );
  return reservations;
}

/** Give the held units back. A line whose reservation is already resolved is left alone. */
export async function releaseOrder(
  tx: Tx,
  actor: StockActor,
  orderId: string,
  lines: readonly LineRef[],
  reason: string,
): Promise<void> {
  for (const line of inLockOrder(lines)) {
    if (!line.reservationId) continue;
    await resolveReservation(
      tx,
      actor.tenantId,
      line.reservationId,
      'RELEASED',
      meta(actor, orderId, `release:${orderId}:${line.id}`, reason),
    );
  }
}

/** The goods leave: each reservation is fulfilled (a SHIP movement). */
export async function shipOrder(
  tx: Tx,
  actor: StockActor,
  orderId: string,
  lines: readonly LineRef[],
): Promise<void> {
  for (const line of inLockOrder(lines)) {
    if (!line.reservationId) continue;
    const done = await resolveReservation(
      tx,
      actor.tenantId,
      line.reservationId,
      'FULFILLED',
      meta(actor, orderId, `ship:${orderId}:${line.id}`),
    );
    if (!done)
      throw new ApiError('conflict', `The stock held for ${line.sku} is no longer reserved`);
  }
}

/** What came back of one line. */
export interface ReturnedLine {
  condition: 'RESALEABLE' | 'DAMAGED';
  quantity: number;
}
/** The lines that came back, by line id. A line that is not in the plan did not come back. */
export type ReturnPlan = ReadonlyMap<string, ReturnedLine>;

const invalid = (path: string, message: string) =>
  new ApiError('validation_failed', 'Request validation failed', [{ path, message }]);

/**
 * Decide what came back. With no `returned` list the whole parcel is back and resaleable (a person confirming a plain
 * return, or a bulk action). With a list, ONLY the listed lines come back, each in its `quantity` (default: the whole
 * line, at most the line's quantity): an unlisted line stays with the customer, so no stock is added for it.
 */
export function planReturn(
  lines: readonly LineRef[],
  returned: readonly { itemId: string; condition: 'RESALEABLE' | 'DAMAGED'; quantity?: number }[],
): ReturnPlan {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const plan = new Map<string, ReturnedLine>();
  if (returned.length === 0) {
    for (const l of lines) plan.set(l.id, { condition: 'RESALEABLE', quantity: l.quantity });
    return plan;
  }
  for (const [i, r] of returned.entries()) {
    const line = byId.get(r.itemId);
    if (!line) throw invalid(`body.returnedItems.${i}.itemId`, 'That line is not on this order');
    if (plan.has(r.itemId))
      throw invalid(`body.returnedItems.${i}.itemId`, 'That line is listed twice');
    const quantity = r.quantity ?? line.quantity;
    if (quantity > line.quantity)
      throw invalid(
        `body.returnedItems.${i}.quantity`,
        `Only ${line.quantity} of ${line.sku} were sent`,
      );
    plan.set(r.itemId, { condition: r.condition, quantity });
  }
  return plan;
}

/** For the status history and audit: per line, how many were sent and how many came back. */
export const describeReturn = (lines: readonly LineRef[], plan: ReturnPlan) =>
  lines.map((l) => ({
    itemId: l.id,
    sku: l.sku,
    sent: l.quantity,
    returned: plan.get(l.id)?.quantity ?? 0,
    condition: plan.get(l.id)?.condition ?? null,
  }));

/** The goods come back: resaleable ones to the shelf, damaged ones to the damaged bucket, the rest not at all. */
export async function restockOrder(
  tx: Tx,
  actor: StockActor,
  orderId: string,
  lines: readonly LineRef[],
  plan: ReturnPlan,
  reason: string,
): Promise<void> {
  for (const line of inLockOrder(lines)) {
    const back = plan.get(line.id);
    if (!back) continue;
    // Back where it left from: the location of the reservation that was shipped.
    const reservation = line.reservationId
      ? await tx.reservation.findUnique({
          where: { id: line.reservationId },
          select: { locationId: true },
        })
      : null;
    const locationId = reservation?.locationId ?? (await resolveLocation(tx, actor.tenantId));
    await returnStock(
      tx,
      { tenantId: actor.tenantId, variantId: line.variantId, locationId },
      back.quantity,
      back.condition,
      meta(actor, orderId, `return:${orderId}:${line.id}`, reason),
    );
  }
}
