/**
 * TikTok Shop channel rules, as pure functions (docs/tiktok-shop.md). TikTok orders are a READ-ONLY mirror in the SHOP'S OWN
 * currency: nothing here converts money, and nothing here knows a buyer (no name, phone, email or address ever reaches this
 * module). The database layer (packages/catalog) applies what `planTikTokStock` decides; this module is the executable
 * specification that layer is tested against.
 */

// ---- statuses ---------------------------------------------------------------------------------------------------------

/** The order statuses TikTok documents (names from the SDK sources; verify against partner.tiktokshop.com). */
export const TIKTOK_STATUSES = [
  'UNPAID',
  'ON_HOLD',
  'AWAITING_SHIPMENT',
  'PARTIALLY_SHIPPING',
  'AWAITING_COLLECTION',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type TikTokStatus = (typeof TIKTOK_STATUSES)[number];

/** Upper-case with underscores; anything blank becomes `UNKNOWN` (which has no stock effect). */
export function normalizeTikTokStatus(raw: string | null | undefined): string {
  const s = (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return s || 'UNKNOWN';
}

/**
 * The status the stock rules look at. TikTok marks an order that is still inside the buyer's cancellation window with a flag
 * (`is_on_hold_order`) while the status reads AWAITING_SHIPMENT: no stock moves until the hold ends.
 */
export function effectiveTikTokStatus(raw: string | null | undefined, onHold: boolean): string {
  const s = normalizeTikTokStatus(raw);
  if (onHold && (s === 'UNPAID' || s === 'AWAITING_SHIPMENT' || s === 'AWAITING_COLLECTION'))
    return 'ON_HOLD';
  return s;
}

const RANK: Record<string, number> = {
  UNPAID: 0,
  ON_HOLD: 1,
  AWAITING_SHIPMENT: 2,
  PARTIALLY_SHIPPING: 3,
  AWAITING_COLLECTION: 4,
  IN_TRANSIT: 5,
  DELIVERED: 6,
  COMPLETED: 7,
  CANCELLED: 7,
};
/** How far along an order is; only used to break a tie between two updates with the same timestamp. */
export const tikTokStatusRank = (status: string): number =>
  RANK[normalizeTikTokStatus(status)] ?? 0;

export const isFinalTikTokStatus = (status: string): boolean => {
  const s = normalizeTikTokStatus(status);
  return s === 'COMPLETED' || s === 'CANCELLED' || s === 'DELIVERED';
};

/**
 * Whether an incoming snapshot may replace what is stored. TikTok's own `update_time` decides (not our arrival order), so a
 * late or replayed notification can never move an order backwards. Equal timestamps: the further-along status wins.
 */
export function isNewerTikTokSnapshot(
  existing: { status: string; updatedAt: Date | null } | null,
  incoming: { status: string; updatedAt: Date },
): boolean {
  if (!existing || !existing.updatedAt) return true;
  const a = incoming.updatedAt.getTime();
  const b = existing.updatedAt.getTime();
  if (a !== b) return a > b;
  return tikTokStatusRank(incoming.status) >= tikTokStatusRank(existing.status);
}

// ---- money (the shop's own currency, integer minor units, never converted) ------------------------------------------------

const ZERO_DECIMAL = new Set([
  'JPY',
  'KRW',
  'VND',
  'CLP',
  'ISK',
  'UGX',
  'XAF',
  'XOF',
  'XPF',
  'PYG',
  'RWF',
  'VUV',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** Decimal places of a currency's minor unit (ISO 4217). Always sent with an order so a client never has to guess. */
export function currencyExponent(currency: string | null | undefined): number {
  const c = (currency ?? '').toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/**
 * TikTok sends amounts as decimal strings in major units ("12.50"). This returns the integer count of minor units, exactly
 * (no floating point), rounding half up when there are more decimals than the currency has. `null` for a blank or malformed
 * value, so a bad field never becomes a wrong number.
 */
export function parseMinorUnits(
  amount: string | number | null | undefined,
  exponent: number,
): bigint | null {
  if (amount === null || amount === undefined) return null;
  const text =
    typeof amount === 'number' ? (Number.isFinite(amount) ? String(amount) : '') : amount.trim();
  if (!/^\d{1,18}(\.\d{1,18})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.') as [string, string?];
  const scale = BigInt(10) ** BigInt(exponent);
  let minor = BigInt(whole) * scale;
  const kept = fraction.slice(0, exponent).padEnd(exponent, '0');
  if (exponent > 0) minor += BigInt(kept);
  const next = fraction.charAt(exponent);
  if (next !== '' && next >= '5') minor += BigInt(1);
  return minor;
}

// ---- tokens -----------------------------------------------------------------------------------------------------------

/**
 * What TikTok calls `access_token_expire_in`: TikTok's documentation describes a Unix timestamp, other sources describe a
 * number of seconds from now. A value that is plausibly a timestamp (after 2001) is taken as one; anything smaller is taken as
 * a duration. Returns null for a missing or unusable value (the caller then refreshes early rather than guessing).
 */
export function tikTokExpiry(value: unknown, now: Date): Date | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n >= 1_000_000_000 ? new Date(n * 1000) : new Date(now.getTime() + n * 1000);
}

const MIN_WINDOW_MS = 10 * 60_000;
const MAX_WINDOW_MS = 24 * 3600_000;

/** How long before expiry a token is renewed: half its lifetime, at least 10 minutes and at most 24 hours. */
export function tikTokRefreshWindowMs(lifetimeMs: number | null): number {
  if (lifetimeMs === null || !(lifetimeMs > 0)) return MAX_WINDOW_MS;
  return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, lifetimeMs / 2));
}

/**
 * Whether a connection's tokens should be renewed now: the access token or the refresh token is inside its window, or the
 * access expiry is unknown. `obtainedAt` is when the tokens were issued (it gives the lifetime, and so the window).
 */
export function tikTokRefreshDue(
  now: Date,
  t: {
    obtainedAt: Date | null;
    accessExpiresAt: Date | null;
    refreshExpiresAt: Date | null;
  },
): boolean {
  const check = (expires: Date | null): boolean => {
    if (!expires) return true;
    const lifetime = t.obtainedAt ? expires.getTime() - t.obtainedAt.getTime() : null;
    return expires.getTime() - now.getTime() <= tikTokRefreshWindowMs(lifetime);
  };
  // An unknown access expiry is a reason to renew; an unknown refresh expiry is not (TikTok may never say, and it would renew for ever).
  return check(t.accessExpiresAt) || (t.refreshExpiresAt !== null && check(t.refreshExpiresAt));
}

/** Delay before the next refresh attempt after `failures` failures in a row: 15 minutes doubling, at most 6 hours. */
export const tikTokRefreshBackoffMs = (failures: number): number =>
  Math.min(6 * 3600_000, 15 * 60_000 * 2 ** Math.max(0, failures - 1));

// ---- stock rules ----------------------------------------------------------------------------------------------------------

export type TikTokHoldState = 'held' | 'shipped' | 'released';
export type TikTokStockState =
  'none' | 'reserved' | 'shipped' | 'released' | 'needs_mapping' | 'stock_short';
export type TikTokStockIntent = 'none' | 'reserve' | 'ship' | 'release';

/** What a status asks of the stock (docs/tiktok-shop.md, "Stock rules"). Unknown statuses ask for nothing. */
export function tikTokStockIntent(effectiveStatus: string): TikTokStockIntent {
  switch (normalizeTikTokStatus(effectiveStatus)) {
    case 'AWAITING_SHIPMENT':
    case 'AWAITING_COLLECTION':
    case 'PARTIALLY_SHIPPING':
      return 'reserve';
    case 'IN_TRANSIT':
    case 'DELIVERED':
    case 'COMPLETED':
      return 'ship';
    case 'CANCELLED':
      return 'release';
    default:
      return 'none';
  }
}

export interface TikTokReconcileLine {
  /** Stable per order: `sku:<TikTok sku id>`. One stock effect per key, ever. */
  key: string;
  quantity: number;
  /** The variant the line goes against: the one its hold was made on, else the SKU link's. Null = not mapped. */
  variantId: string | null;
  hold: TikTokHoldState | null;
}

export type TikTokLineAction = 'reserve' | 'ship' | 'reserve_and_ship' | 'release';

export interface TikTokReconcileInput {
  /** The status as TikTok reports it. */
  status: string;
  onHold: boolean;
  lines: readonly TikTokReconcileLine[];
  /** Units available to sell (on hand minus reserved) at the location orders are filled from, by variant id. */
  available: ReadonlyMap<string, number>;
}

export interface TikTokReconcilePlan {
  intent: TikTokStockIntent;
  actions: { key: string; action: TikTokLineAction }[];
  stockState: TikTokStockState;
  /** Set when stock already left and the order was then cancelled: no automatic change, a person decides (returns are out of scope). */
  attention: 'cancelled_after_shipping' | null;
  blocked: 'needs_mapping' | 'stock_short' | null;
  unmappedKeys: string[];
  shortKeys: string[];
}

/**
 * Decide what the stock must do for one order. Deterministic and repeatable: lines that already have a hold are never acted on
 * twice, so running it again after a retry, a duplicate delivery or a replay plans nothing new.
 *
 * - UNPAID / ON_HOLD / unknown: nothing.
 * - AWAITING_SHIPMENT / AWAITING_COLLECTION / PARTIALLY_SHIPPING: reserve every line that has no hold yet.
 * - IN_TRANSIT / DELIVERED / COMPLETED: ship every held line; a line never reserved (the order was first seen late) is
 *   reserved and shipped in one go.
 * - CANCELLED: release what is still held. A line that already shipped is left alone and the order is flagged.
 *
 * New reservations are ALL-OR-NOTHING per order: if any line has no mapped variant the whole order waits (`needs_mapping`); if
 * any variant has less available than the order needs, nothing is reserved (`stock_short`) so stock is never oversold and never
 * half-promised. Shipping lines that are already held is always allowed (the units are already promised).
 */
export function planTikTokStock(input: TikTokReconcileInput): TikTokReconcilePlan {
  const intent = tikTokStockIntent(effectiveTikTokStatus(input.status, input.onHold));
  const actions: TikTokReconcilePlan['actions'] = [];
  let blocked: TikTokReconcilePlan['blocked'] = null;
  let unmappedKeys: string[] = [];
  let shortKeys: string[] = [];
  const final = new Map<string, TikTokHoldState | null>(input.lines.map((l) => [l.key, l.hold]));

  if (intent === 'release') {
    for (const l of input.lines)
      if (l.hold === 'held') {
        actions.push({ key: l.key, action: 'release' });
        final.set(l.key, 'released');
      }
  } else if (intent === 'reserve' || intent === 'ship') {
    if (intent === 'ship')
      for (const l of input.lines)
        if (l.hold === 'held') {
          actions.push({ key: l.key, action: 'ship' });
          final.set(l.key, 'shipped');
        }
    const fresh = input.lines.filter((l) => l.hold === null);
    unmappedKeys = fresh.filter((l) => l.variantId === null).map((l) => l.key);
    if (unmappedKeys.length > 0) blocked = 'needs_mapping';
    else if (fresh.length > 0) {
      const demand = new Map<string, number>();
      for (const l of fresh) demand.set(l.variantId!, (demand.get(l.variantId!) ?? 0) + l.quantity);
      const shortVariants = new Set(
        [...demand].filter(([v, q]) => q > (input.available.get(v) ?? 0)).map(([v]) => v),
      );
      if (shortVariants.size > 0) {
        blocked = 'stock_short';
        shortKeys = fresh.filter((l) => shortVariants.has(l.variantId!)).map((l) => l.key);
      } else
        for (const l of fresh) {
          actions.push({ key: l.key, action: intent === 'ship' ? 'reserve_and_ship' : 'reserve' });
          final.set(l.key, intent === 'ship' ? 'shipped' : 'held');
        }
    }
  }

  const states = [...final.values()];
  const attention =
    intent === 'release' && states.includes('shipped')
      ? ('cancelled_after_shipping' as const)
      : null;
  let stockState: TikTokStockState;
  if (blocked) stockState = blocked;
  else if (states.includes('held')) stockState = 'reserved';
  else if (states.includes('shipped')) stockState = 'shipped';
  else if (states.includes('released')) stockState = 'released';
  else stockState = 'none';
  return { intent, actions, stockState, attention, blocked, unmappedKeys, shortKeys };
}

// ---- the snapshot (what the mirror keeps of an order: no buyer data) ----------------------------------------------------------

export interface TikTokSnapshotLine {
  /** `sku:<externalSkuId>` */
  key: string;
  externalSkuId: string;
  /** The first TikTok line-item id of this SKU (each unit is a line item at TikTok). */
  externalLineId: string | null;
  sellerSku: string | null;
  productName: string | null;
  quantity: number;
  unitPriceMinor: bigint;
}

export interface TikTokOrderSnapshot {
  externalOrderId: string;
  /** As TikTok reports it. */
  status: string;
  onHold: boolean;
  /** TikTok's `update_time`: the clock that orders updates. */
  statusUpdatedAt: Date;
  createdAtTiktok: Date | null;
  currency: string;
  currencyExponent: number;
  subtotalMinor: bigint;
  sellerDiscountMinor: bigint;
  platformDiscountMinor: bigint;
  shippingMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  fulfilmentType: string | null;
  region: string | null;
  lines: TikTokSnapshotLine[];
}

/** `sku:<id>`: the key one stock effect is recorded under. */
export const tikTokLineKey = (externalSkuId: string): string => `sku:${externalSkuId}`;

// ---- applying a snapshot (the contract between the pollers/workers and the stock code in packages/catalog) -------------------

export interface TikTokApplyInput {
  tenantId: string;
  connectionId: string;
  mock: boolean;
  snapshot: TikTokOrderSnapshot;
}

export interface TikTokApplyResult {
  /** The mirrored order's id. */
  orderId: string;
  created: boolean;
  /** False when the snapshot was older than what is stored (late or repeated delivery): the mirror was left alone. */
  applied: boolean;
  stockState: TikTokStockState;
  attention: 'cancelled_after_shipping' | null;
  /** Lines the stock acted on in this call. All zero on a repeat: nothing happens twice. */
  reserved: number;
  shipped: number;
  released: number;
}
