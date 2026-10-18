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

/** Reserve every line, or none: any shortage rolls the whole transaction back and names every short line. */
export async function reserveOrder(
  tx: Tx,
  runner: StockRunner,
  actor: StockActor,
  orderId: string,
  lines: readonly LineRef[],
): Promise<Map<string, string>> {
  // A fixed order (by variant) so two orders confirming at once cannot lock each other's stock in opposite directions.
  const ordered = [...lines].sort(
    (a, b) => a.variantId.localeCompare(b.variantId) || a.id.localeCompare(b.id),
  );
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
      short.push({
        path: `items.${index.get(line.id)}`,
        message: `${line.sku}: only ${error.available} available, ${error.requested} needed`,
      });
    }
  }
  if (short.length)
    throw new ApiError(
      409,
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
  for (const line of lines) {
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
  for (const line of lines) {
    if (!line.reservationId) continue;
    const done = await resolveReservation(
      tx,
      actor.tenantId,
      line.reservationId,
      'FULFILLED',
      meta(actor, orderId, `ship:${orderId}:${line.id}`),
    );
    if (!done)
      throw new ApiError(409, 'conflict', `The stock held for ${line.sku} is no longer reserved`);
  }
}

/** The goods come back: resaleable ones to the shelf, damaged ones to the damaged bucket. */
export async function restockOrder(
  tx: Tx,
  actor: StockActor,
  orderId: string,
  lines: readonly LineRef[],
  conditions: ReadonlyMap<string, 'RESALEABLE' | 'DAMAGED'>,
  reason: string,
): Promise<void> {
  for (const line of lines) {
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
      line.quantity,
      conditions.get(line.id) ?? 'RESALEABLE',
      meta(actor, orderId, `return:${orderId}:${line.id}`, reason),
    );
  }
}
