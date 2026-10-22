import { createHash } from 'node:crypto';
import {
  currencyExponent,
  parseMinorUnits,
  tikTokLineKey,
  type TikTokOrderSnapshot,
  type TikTokSnapshotLine,
} from '@orderloop/domain';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null;

/** Epoch seconds (TikTok) or milliseconds, as a Date; null for anything else. */
function toDate(v: unknown): Date | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n < 100_000_000_000 ? n * 1000 : n);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---- webhooks ------------------------------------------------------------------------------------------------------------

/** What an event is, as far as OrderLoop cares. */
export type TikTokEventKind = 'order_status' | 'package' | 'deauthorization' | 'other';

export interface TikTokWebhookEvent {
  shopId: string;
  /** The idempotency key: `tts_notification_id`, or a deterministic hash when TikTok sent none. */
  key: string;
  /** TikTok's numeric `type` (unreliable to branch on: see `kindOf`). */
  type: number | null;
  kind: TikTokEventKind;
  orderId: string | null;
  /** What the notification says the new status is. Only a MOCK shop trusts it; a live shop always asks TikTok. */
  orderStatus: string | null;
  /** `is_on_hold_order` as the notification says it. Like the status, only a MOCK shop trusts it. */
  onHold: boolean | null;
  updateTime: Date | null;
  /** When TikTok sent it. */
  timestamp: Date;
  /** Mock events only: the whole synthetic order (there is no TikTok to ask). */
  mockOrder?: TikTokOrderSnapshot | undefined;
}

/** The numeric types the SDK names (Webhook.php). */
const TYPE_KIND: Record<number, TikTokEventKind> = {
  1: 'order_status', // ORDER_STATUS_UPDATE
  4: 'package', // PACKAGE_UPDATE
  6: 'deauthorization', // SELLER_DEAUTHORIZATION
  2: 'other', // REVERSE_ORDER_STATUS_UPDATE
  3: 'other', // RECIPIENT_ADDRESS_UPDATE (carries an address: never kept)
  5: 'other', // PRODUCT_STATUS_UPDATE
  7: 'other', // UPCOMING_AUTHORIZATION_EXPIRATION
  12: 'other', // RETURN_STATUS_UPDATE
};

/**
 * The numeric `type` is documented as unreliable to branch on. A type the SDK names decides; for an unknown (or missing) type
 * the shape of `data` does: an order id with an order status is an order status change.
 */
function kindOf(type: number | null, data: Json): TikTokEventKind {
  if (type !== null && TYPE_KIND[type]) return TYPE_KIND[type]!;
  if (str(data['order_id']) && str(data['order_status'])) return 'order_status';
  return 'other';
}

/** A deterministic key for a notification that carries no id, so a repeat of it is still recognised. */
export function deriveTikTokEventKey(parts: {
  shopId: string;
  type: number | null;
  timestamp: number | null;
  orderId: string | null;
  orderStatus: string | null;
}): string {
  const h = createHash('sha256')
    .update(
      [
        parts.shopId,
        parts.type ?? '',
        parts.timestamp ?? '',
        parts.orderId ?? '',
        parts.orderStatus ?? '',
      ].join('|'),
    )
    .digest('hex');
  return `derived_${h.slice(0, 40)}`;
}

/**
 * Read a webhook body that has already passed signature verification. Keeps ids and a status word only (the notification's
 * `data` is dropped as soon as it has been read). Null when it is not a notification we can attach to a shop.
 */
export function parseTikTokWebhook(body: unknown): TikTokWebhookEvent | null {
  if (!isObject(body)) return null;
  const shopId = str(body['shop_id']);
  if (!shopId || shopId.length > 64) return null;
  const type =
    typeof body['type'] === 'number'
      ? (body['type'] as number)
      : Number.isFinite(Number(body['type'])) && body['type'] !== '' && body['type'] !== null
        ? Number(body['type'])
        : null;
  const data = isObject(body['data']) ? body['data'] : {};
  const orderId = str(data['order_id']);
  const orderStatus = str(data['order_status']);
  const timestampSeconds =
    typeof body['timestamp'] === 'number' ? (body['timestamp'] as number) : null;
  const notificationId = str(body['tts_notification_id']);
  const key =
    notificationId && notificationId.length <= 100
      ? notificationId
      : deriveTikTokEventKey({ shopId, type, timestamp: timestampSeconds, orderId, orderStatus });
  return {
    shopId,
    key,
    type,
    kind: kindOf(type, data),
    orderId: orderId && orderId.length <= 64 ? orderId : null,
    orderStatus: orderStatus && orderStatus.length <= 40 ? orderStatus : null,
    onHold: typeof data['is_on_hold_order'] === 'boolean' ? data['is_on_hold_order'] : null,
    updateTime: toDate(data['update_time']),
    timestamp: toDate(body['timestamp']) ?? new Date(),
  };
}

// ---- orders --------------------------------------------------------------------------------------------------------------------

export interface ParseOrderContext {
  /** The shop's region (from the connection), not anything taken from the buyer's address. */
  region: string | null;
  /** Used when TikTok sent no `update_time`: the moment the order was read. */
  fallbackUpdatedAt: Date;
}

/**
 * TikTok's order object -> the snapshot OrderLoop keeps. This is the privacy boundary: ONLY the fields named below are read.
 * `recipient_address`, `buyer_email`, `buyer_message`, `user_id`, `seller_note` and every other field are never touched, so no
 * buyer data can reach the mirror, an event, a log or a job. Returns null when the order has no id, no currency, or no lines.
 *
 * Each unit is its own entry in TikTok's `line_items`; they are added up per SKU (a `quantity` field, if one is present, is honoured).
 */
export function parseTikTokOrder(raw: unknown, ctx: ParseOrderContext): TikTokOrderSnapshot | null {
  if (!isObject(raw)) return null;
  const externalOrderId = str(raw['id']);
  const payment = isObject(raw['payment']) ? raw['payment'] : {};
  const currency = (str(payment['currency']) ?? '').toUpperCase();
  if (!externalOrderId || !/^[A-Z]{3}$/.test(currency)) return null;
  const exponent = currencyExponent(currency);
  const money = (v: unknown): bigint =>
    parseMinorUnits(typeof v === 'number' ? v : (str(v) ?? undefined), exponent) ?? 0n;

  const byKey = new Map<string, TikTokSnapshotLine>();
  for (const item of Array.isArray(raw['line_items']) ? (raw['line_items'] as unknown[]) : []) {
    if (!isObject(item)) continue;
    const skuId = str(item['sku_id']);
    if (!skuId) continue;
    const key = tikTokLineKey(skuId);
    const units =
      typeof item['quantity'] === 'number' &&
      Number.isInteger(item['quantity']) &&
      (item['quantity'] as number) > 0
        ? (item['quantity'] as number)
        : 1;
    const seen = byKey.get(key);
    if (seen) seen.quantity += units;
    else
      byKey.set(key, {
        key,
        externalSkuId: skuId,
        externalLineId: str(item['id']),
        sellerSku: str(item['seller_sku']),
        productName: str(item['product_name'])?.slice(0, 200) ?? null,
        quantity: units,
        unitPriceMinor: money(item['sale_price']),
      });
  }
  if (byKey.size === 0) return null;
  const updated = toDate(raw['update_time']);
  return {
    externalOrderId,
    status: str(raw['status']) ?? 'UNKNOWN',
    onHold: raw['is_on_hold_order'] === true,
    statusUpdatedAt: updated ?? ctx.fallbackUpdatedAt,
    createdAtTiktok: toDate(raw['create_time']),
    currency,
    currencyExponent: exponent,
    subtotalMinor: money(payment['sub_total']),
    sellerDiscountMinor: money(payment['seller_discount']),
    platformDiscountMinor: money(payment['platform_discount']),
    shippingMinor: money(payment['shipping_fee']),
    taxMinor: money(payment['tax']),
    totalMinor: money(payment['total_amount']),
    fulfilmentType: str(raw['fulfillment_type']),
    region: ctx.region,
    lines: [...byKey.values()],
  };
}

// ---- the snapshot as JSON (mock events carry one) ---------------------------------------------------------------------------------

/** A snapshot as plain JSON (money as decimal strings, dates as ISO text): bigint cannot go into a JSON column. */
export function snapshotToJson(s: TikTokOrderSnapshot): Json {
  return {
    externalOrderId: s.externalOrderId,
    status: s.status,
    onHold: s.onHold,
    statusUpdatedAt: s.statusUpdatedAt.toISOString(),
    createdAtTiktok: s.createdAtTiktok?.toISOString() ?? null,
    currency: s.currency,
    currencyExponent: s.currencyExponent,
    subtotalMinor: s.subtotalMinor.toString(),
    sellerDiscountMinor: s.sellerDiscountMinor.toString(),
    platformDiscountMinor: s.platformDiscountMinor.toString(),
    shippingMinor: s.shippingMinor.toString(),
    taxMinor: s.taxMinor.toString(),
    totalMinor: s.totalMinor.toString(),
    fulfilmentType: s.fulfilmentType,
    region: s.region,
    lines: s.lines.map((l) => ({ ...l, unitPriceMinor: l.unitPriceMinor.toString() })),
  };
}

const big = (v: unknown): bigint => {
  try {
    return typeof v === 'string' || typeof v === 'number' ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
};

/** The inverse of `snapshotToJson`; null when the JSON is not one. Used for mock events and for stored order rows. */
export function snapshotFromJson(v: unknown): TikTokOrderSnapshot | null {
  if (!isObject(v)) return null;
  const externalOrderId = str(v['externalOrderId']);
  const status = str(v['status']);
  const updated = toDate(
    typeof v['statusUpdatedAt'] === 'string' ? Date.parse(v['statusUpdatedAt']) : null,
  );
  const currency = str(v['currency']);
  if (!externalOrderId || !status || !updated || !currency) return null;
  const lines: TikTokSnapshotLine[] = [];
  for (const l of Array.isArray(v['lines']) ? (v['lines'] as unknown[]) : []) {
    if (!isObject(l)) continue;
    const externalSkuId = str(l['externalSkuId']);
    if (!externalSkuId) continue;
    lines.push({
      key: tikTokLineKey(externalSkuId),
      externalSkuId,
      externalLineId: str(l['externalLineId']),
      sellerSku: str(l['sellerSku']),
      productName: str(l['productName']),
      quantity: typeof l['quantity'] === 'number' ? (l['quantity'] as number) : 1,
      unitPriceMinor: big(l['unitPriceMinor']),
    });
  }
  const created =
    typeof v['createdAtTiktok'] === 'string' ? toDate(Date.parse(v['createdAtTiktok'])) : null;
  return {
    externalOrderId,
    status,
    onHold: v['onHold'] === true,
    statusUpdatedAt: updated,
    createdAtTiktok: created,
    currency,
    currencyExponent:
      typeof v['currencyExponent'] === 'number'
        ? (v['currencyExponent'] as number)
        : currencyExponent(currency),
    subtotalMinor: big(v['subtotalMinor']),
    sellerDiscountMinor: big(v['sellerDiscountMinor']),
    platformDiscountMinor: big(v['platformDiscountMinor']),
    shippingMinor: big(v['shippingMinor']),
    taxMinor: big(v['taxMinor']),
    totalMinor: big(v['totalMinor']),
    fulfilmentType: str(v['fulfilmentType']),
    region: str(v['region']),
    lines,
  };
}
