import type { Prisma, Tx } from '@orderloop/db';
import {
  isNewerTikTokSnapshot,
  planTikTokStock,
  tikTokStockIntent,
  effectiveTikTokStatus,
  type TikTokApplyInput,
  type TikTokApplyResult,
  type TikTokHoldState,
  type TikTokOrderSnapshot,
  type TikTokReconcileLine,
  type TikTokSnapshotLine,
} from '@orderloop/domain';
import { reserveStock, resolveLocation, resolveReservation, type MovementMeta } from './stock.js';

export const TIKTOK_REFERENCE = 'tiktok_order';

interface StoredLine {
  key: string;
  externalSkuId: string;
  externalLineId: string | null;
  sellerSku: string | null;
  productName: string | null;
  quantity: number;
  unitPriceMinor: string;
}

const lineToJson = (l: TikTokSnapshotLine): StoredLine => ({
  key: l.key,
  externalSkuId: l.externalSkuId,
  externalLineId: l.externalLineId,
  sellerSku: l.sellerSku,
  productName: l.productName,
  quantity: l.quantity,
  unitPriceMinor: l.unitPriceMinor.toString(),
});

export function readStoredLines(json: Prisma.JsonValue): StoredLine[] {
  if (!Array.isArray(json)) return [];
  return json.filter(
    (l): l is Record<string, never> => typeof l === 'object' && l !== null && !Array.isArray(l),
  ) as unknown as StoredLine[];
}

const holdMeta = (
  orderId: string,
  externalOrderId: string,
  kind: 'reserve' | 'ship' | 'release',
  key: string,
): MovementMeta => ({
  createdById: null,
  referenceType: TIKTOK_REFERENCE,
  referenceId: orderId,
  idempotencyKey: `tt-${kind}:${orderId}:${key}`,
  // The order id TikTok gave: a shop-side identifier, no buyer data.
  reason: `TikTok order ${externalOrderId}`.slice(0, 200),
});

// ---- SKU links -------------------------------------------------------------------------------------------------------------

/** The one active variant whose SKU equals `sellerSku` (case-insensitive, exact), or null when there is none or more than one. */
async function uniqueVariantBySku(
  tx: Tx,
  tenantId: string,
  sellerSku: string,
): Promise<string | null> {
  const sku = sellerSku.trim();
  if (!sku) return null;
  const found = await tx.productVariant.findMany({
    where: {
      tenantId,
      archivedAt: null,
      product: { status: { not: 'ARCHIVED' } },
      sku: { equals: sku, mode: 'insensitive' },
    },
    select: { id: true },
    take: 2,
  });
  return found.length === 1 ? found[0]!.id : null;
}

/**
 * Make sure every SKU on the order has a link row, and try to link the unlinked ones: automatically, on first sight, by the seller
 * SKU equalling an OrderLoop variant SKU (case-insensitive, exact, and only when exactly one variant matches). A link a person has
 * set or cleared (`manual`) is never touched.
 */
export async function ensureTikTokSkuLinks(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  lines: readonly Pick<TikTokSnapshotLine, 'externalSkuId' | 'sellerSku' | 'productName'>[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.tikTokSkuLink.createMany({
    skipDuplicates: true,
    data: lines.map((l) => ({
      tenantId,
      connectionId,
      externalSkuId: l.externalSkuId,
      sellerSku: l.sellerSku,
      productName: l.productName,
    })),
  });
  const links = await tx.tikTokSkuLink.findMany({
    where: { tenantId, connectionId, externalSkuId: { in: lines.map((l) => l.externalSkuId) } },
  });
  const info = new Map(lines.map((l) => [l.externalSkuId, l]));
  for (const link of links) {
    const seen = info.get(link.externalSkuId);
    const fill = {
      ...(!link.sellerSku && seen?.sellerSku ? { sellerSku: seen.sellerSku } : {}),
      ...(!link.productName && seen?.productName ? { productName: seen.productName } : {}),
    };
    let variantId: string | null = null;
    if (!link.variantId && link.source === 'auto') {
      variantId = await uniqueVariantBySku(tx, tenantId, link.sellerSku ?? seen?.sellerSku ?? '');
    }
    if (Object.keys(fill).length > 0 || variantId) {
      await tx.tikTokSkuLink.update({
        where: { id: link.id },
        data: { ...fill, ...(variantId ? { variantId } : {}) },
      });
      if (variantId)
        await tx.auditLog.createMany({
          data: [
            {
              tenantId,
              actorUserId: null,
              action: 'tiktok.sku_linked',
              targetType: 'tiktok_sku_link',
              targetId: link.id,
              metadata: { variantId, source: 'auto' },
            },
          ],
        });
    }
  }
}

// ---- the mirror -------------------------------------------------------------------------------------------------------------------

const orderData = (s: TikTokOrderSnapshot) => ({
  status: s.status,
  onHold: s.onHold,
  statusUpdatedAt: s.statusUpdatedAt,
  createdAtTiktok: s.createdAtTiktok,
  currency: s.currency,
  currencyExponent: s.currencyExponent,
  subtotalMinor: s.subtotalMinor,
  sellerDiscountMinor: s.sellerDiscountMinor,
  platformDiscountMinor: s.platformDiscountMinor,
  shippingMinor: s.shippingMinor,
  taxMinor: s.taxMinor,
  totalMinor: s.totalMinor,
  fulfilmentType: s.fulfilmentType,
  region: s.region,
  lineItems: s.lines.map(lineToJson) as unknown as Prisma.InputJsonValue,
});

/**
 * Put one TikTok order into the mirror and run the stock rules for it. Idempotent and never backwards: an advisory lock per
 * (connection, TikTok order id) serialises writers; a snapshot with an older TikTok `update_time` than the stored one changes
 * nothing about the order (the stock rules still run, harmlessly, against what is stored).
 */
export async function applyTikTokOrder(
  tx: Tx,
  input: TikTokApplyInput,
): Promise<TikTokApplyResult> {
  const { tenantId, connectionId, snapshot } = input;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tiktok-order|${connectionId}|${snapshot.externalOrderId}`}, 0))`;
  const existing = await tx.tikTokOrder.findFirst({
    where: { tenantId, connectionId, externalOrderId: snapshot.externalOrderId },
  });
  const newer = isNewerTikTokSnapshot(
    existing ? { status: existing.status, updatedAt: existing.statusUpdatedAt } : null,
    { status: snapshot.status, updatedAt: snapshot.statusUpdatedAt },
  );
  let orderId: string;
  if (!existing) {
    const row = await tx.tikTokOrder.create({
      data: {
        tenantId,
        connectionId,
        externalOrderId: snapshot.externalOrderId,
        mock: input.mock,
        ...orderData(snapshot),
      },
      select: { id: true },
    });
    orderId = row.id;
  } else {
    orderId = existing.id;
    if (newer)
      await tx.tikTokOrder.update({ where: { id: existing.id }, data: orderData(snapshot) });
  }
  const applied = !existing || newer;
  if (applied) {
    await ensureTikTokSkuLinks(tx, tenantId, connectionId, snapshot.lines);
    await tx.tikTokConnection.updateMany({
      where: { id: connectionId, tenantId, currency: null },
      data: { currency: snapshot.currency },
    });
  }
  const r = await reconcileTikTokOrder(tx, { tenantId, orderId });
  return { ...r, created: !existing, applied };
}

// ---- the stock --------------------------------------------------------------------------------------------------------------------

/**
 * Run the stock rules for one stored order and apply what they decide, in this transaction. The order row is locked first, so
 * concurrent callers (webhook jobs, the catch-up check, a person mapping a SKU) take turns, and the second finds the holds the
 * first made. Lines are processed in a fixed order (variant, then line) so two orders touching the same stock cannot lock it in
 * opposite directions.
 */
export async function reconcileTikTokOrder(
  tx: Tx,
  ref: { tenantId: string; orderId: string },
): Promise<TikTokApplyResult> {
  const { tenantId, orderId } = ref;
  const locked = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM tiktok_orders WHERE tenant_id = ${tenantId}::uuid AND id = ${orderId}::uuid FOR UPDATE`;
  if (!locked[0]) throw new Error('TikTok order not found');
  const order = await tx.tikTokOrder.findFirstOrThrow({ where: { id: orderId, tenantId } });
  const stored = readStoredLines(order.lineItems);
  await ensureTikTokSkuLinks(tx, tenantId, order.connectionId, stored);
  const [holds, links] = await Promise.all([
    tx.tikTokStockHold.findMany({ where: { tenantId, tiktokOrderId: orderId } }),
    tx.tikTokSkuLink.findMany({
      where: {
        tenantId,
        connectionId: order.connectionId,
        externalSkuId: { in: stored.map((l) => l.externalSkuId) },
      },
      select: { externalSkuId: true, variantId: true, variant: { select: { archivedAt: true } } },
    }),
  ]);
  const holdByKey = new Map(holds.map((h) => [h.lineKey, h]));
  const linkBySku = new Map(links.map((l) => [l.externalSkuId, l]));
  const lines: TikTokReconcileLine[] = stored.map((l) => {
    const hold = holdByKey.get(l.key);
    // A line already holding stock keeps the variant it was held on; a fresh one goes through its link (an archived variant is not a target).
    const link = linkBySku.get(l.externalSkuId);
    const linked = link?.variantId && !link.variant?.archivedAt ? link.variantId : null;
    return {
      key: l.key,
      quantity: l.quantity,
      variantId: hold?.variantId ?? linked,
      hold: (hold?.state as TikTokHoldState | undefined) ?? null,
    };
  });

  const intent = tikTokStockIntent(effectiveTikTokStatus(order.status, order.onHold));
  const fresh = lines.filter((l) => l.hold === null && l.variantId !== null);
  const available = new Map<string, number>();
  let locationId: string | null = null;
  if ((intent === 'reserve' || intent === 'ship') && fresh.length > 0) {
    locationId = await resolveLocation(tx, tenantId);
    const variantIds = [...new Set(fresh.map((l) => l.variantId!))].sort();
    // Locked in variant order: what we read is what the reservation below will see.
    const rows = await tx.$queryRaw<{ variant_id: string; available: number }[]>`
      SELECT variant_id, (on_hand - reserved)::int AS available FROM stock_levels
      WHERE tenant_id = ${tenantId}::uuid AND location_id = ${locationId}::uuid AND variant_id = ANY(${variantIds}::uuid[])
      ORDER BY variant_id FOR UPDATE`;
    for (const r of rows) available.set(r.variant_id, r.available);
  }
  const plan = planTikTokStock({ status: order.status, onHold: order.onHold, lines, available });

  const byKey = new Map(lines.map((l) => [l.key, l]));
  const ordered = [...plan.actions].sort(
    (a, b) =>
      (byKey.get(a.key)!.variantId ?? '').localeCompare(byKey.get(b.key)!.variantId ?? '') ||
      a.key.localeCompare(b.key),
  );
  let reserved = 0;
  let shipped = 0;
  let released = 0;
  for (const { key, action } of ordered) {
    const line = byKey.get(key)!;
    let hold = holdByKey.get(key) ?? null;
    if (action === 'reserve' || action === 'reserve_and_ship') {
      const target = { tenantId, variantId: line.variantId!, locationId: locationId! };
      const r = await reserveStock(
        tx,
        target,
        line.quantity,
        holdMeta(orderId, order.externalOrderId, 'reserve', key),
      );
      hold = await tx.tikTokStockHold.create({
        data: {
          tenantId,
          tiktokOrderId: orderId,
          lineKey: key,
          variantId: line.variantId!,
          quantity: line.quantity,
          reservationId: r.reservationId,
          state: 'held',
        },
      });
      reserved++;
    }
    if (action === 'ship' || action === 'reserve_and_ship') {
      const done = await resolveReservation(
        tx,
        tenantId,
        hold!.reservationId,
        'FULFILLED',
        holdMeta(orderId, order.externalOrderId, 'ship', key),
      );
      await settleHold(tx, tenantId, hold!, done ? 'shipped' : null);
      if (done) shipped++;
    }
    if (action === 'release') {
      const done = await resolveReservation(
        tx,
        tenantId,
        hold!.reservationId,
        'RELEASED',
        holdMeta(orderId, order.externalOrderId, 'release', key),
      );
      await settleHold(tx, tenantId, hold!, done ? 'released' : null);
      if (done) released++;
    }
  }

  if (order.stockState !== plan.stockState || order.attention !== plan.attention)
    await tx.tikTokOrder.update({
      where: { id: orderId },
      data: { stockState: plan.stockState, attention: plan.attention },
    });
  return {
    orderId,
    created: false,
    applied: true,
    stockState: plan.stockState,
    attention: plan.attention,
    reserved,
    shipped,
    released,
  };
}

/**
 * Record what really happened to a hold's reservation. When the resolve found the reservation no longer active (someone else
 * resolved it), the hold follows the reservation's actual status rather than what we meant.
 */
async function settleHold(
  tx: Tx,
  tenantId: string,
  hold: { id: string; reservationId: string },
  intended: 'shipped' | 'released' | null,
): Promise<void> {
  let state: 'shipped' | 'released' | null = intended;
  if (!state) {
    const r = await tx.reservation.findFirst({
      where: { id: hold.reservationId, tenantId },
      select: { status: true },
    });
    if (r?.status === 'FULFILLED') state = 'shipped';
    else if (r?.status === 'RELEASED') state = 'released';
  }
  if (state) await tx.tikTokStockHold.update({ where: { id: hold.id }, data: { state } });
}

/** This connection's orders that are waiting for a SKU link or for stock, oldest first. */
export async function waitingTikTokOrders(
  tx: Tx,
  ref: { tenantId: string; connectionId: string; limit: number },
): Promise<string[]> {
  const rows = await tx.tikTokOrder.findMany({
    where: {
      tenantId: ref.tenantId,
      connectionId: ref.connectionId,
      stockState: { in: ['needs_mapping', 'stock_short'] },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: ref.limit,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** What the worker and the API hand to the pollers (the shape `TikTokOrderSink` in packages/automation asks for). */
export const tiktokOrderSink = {
  apply: applyTikTokOrder,
  reconcile: reconcileTikTokOrder,
  waiting: waitingTikTokOrders,
};
