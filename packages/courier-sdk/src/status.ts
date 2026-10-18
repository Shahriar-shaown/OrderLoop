import type { ShipmentStatus } from './types.js';

/**
 * Provider statuses mapped onto ours. The provider's own text is always stored too; this only decides what we do next.
 * Anything unlisted becomes `unknown`, which changes nothing and is shown to a person.
 */

/** "Pickup Requested", "order.pickup-requested" and "pickup_requested" are the same status. */
export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^order\./, '')
    .replace(/[\s_]+/g, '-');
}

const PATHAO: Record<string, ShipmentStatus> = {
  pending: 'booked',
  created: 'booked',
  'order-created': 'booked',
  'pickup-requested': 'booked',
  'assigned-for-pickup': 'booked',
  picked: 'picked_up',
  'at-the-sorting-hub': 'in_transit',
  'in-transit': 'in_transit',
  'received-at-last-mile-hub': 'in_transit',
  'assigned-for-delivery': 'out_for_delivery',
  delivered: 'delivered',
  'partial-delivery': 'partial_delivered',
  'pickup-failed': 'on_hold',
  'delivery-failed': 'delivery_failed',
  'on-hold': 'on_hold',
  // Returns. Only "returned to merchant" means the parcel is back with the seller.
  return: 'returning',
  returned: 'returning',
  'return-id-created': 'returning',
  'return-in-transit': 'returning',
  'paid-return': 'returning',
  exchanged: 'returning',
  exchange: 'returning',
  'returned-to-merchant': 'returned',
  'pickup-cancelled': 'cancelled',
};

/** Pathao events that report money or housekeeping rather than where the parcel is. They never move a shipment. */
const PATHAO_INFORMATIONAL = new Set(['updated', 'paid']);

/** Returns `null` for an event that says nothing about the parcel's whereabouts. */
export function mapPathaoStatus(value: string): ShipmentStatus | null {
  const slug = normalizeSlug(value);
  if (PATHAO_INFORMATIONAL.has(slug) || slug.startsWith('store.')) return null;
  return PATHAO[slug] ?? 'unknown';
}

const STEADFAST: Record<string, ShipmentStatus> = {
  in_review: 'booked',
  pending: 'booked',
  hold: 'on_hold',
  // Delivered by the courier's account, awaiting the courier's admin to confirm the money. We treat the parcel as delivered.
  delivered_approval_pending: 'delivered',
  delivered: 'delivered',
  partial_delivered_approval_pending: 'partial_delivered',
  partial_delivered: 'partial_delivered',
  cancelled_approval_pending: 'cancelled',
  cancelled: 'cancelled',
  unknown_approval_pending: 'unknown',
  unknown: 'unknown',
};

export function mapSteadfastStatus(value: string): ShipmentStatus {
  return STEADFAST[value.trim().toLowerCase()] ?? 'unknown';
}

/**
 * Which status may follow which. A webhook that arrives late, twice or out of order must never drag a parcel backwards:
 * an event whose status is not a legal next step is recorded and ignored.
 *
 * Deliveries can fail and be retried, so in_transit, out_for_delivery, delivery_failed and on_hold may cycle. A delivered
 * parcel can still be returned by the customer. `returned` and `cancelled` are final.
 */
const NEXT: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  booked: [
    'picked_up',
    'in_transit',
    'out_for_delivery',
    'delivered',
    'partial_delivered',
    'delivery_failed',
    'on_hold',
    'returning',
    'returned',
    'cancelled',
  ],
  picked_up: [
    'in_transit',
    'out_for_delivery',
    'delivered',
    'partial_delivered',
    'delivery_failed',
    'on_hold',
    'returning',
    'returned',
    'cancelled',
  ],
  in_transit: [
    'out_for_delivery',
    'delivered',
    'partial_delivered',
    'delivery_failed',
    'on_hold',
    'returning',
    'returned',
    'cancelled',
  ],
  out_for_delivery: [
    'in_transit',
    'delivered',
    'partial_delivered',
    'delivery_failed',
    'on_hold',
    'returning',
    'returned',
    'cancelled',
  ],
  delivery_failed: [
    'in_transit',
    'out_for_delivery',
    'delivered',
    'partial_delivered',
    'on_hold',
    'returning',
    'returned',
    'cancelled',
  ],
  on_hold: [
    'picked_up',
    'in_transit',
    'out_for_delivery',
    'delivered',
    'partial_delivered',
    'delivery_failed',
    'returning',
    'returned',
    'cancelled',
  ],
  partial_delivered: ['delivered', 'returning', 'returned'],
  delivered: ['returning', 'returned'],
  returning: ['returned', 'delivered', 'in_transit'],
  returned: [],
  cancelled: [],
  unknown: [],
};

export type Advance =
  | { apply: true }
  | { apply: false; reason: 'duplicate' | 'not_a_status' | 'out_of_order' | 'unknown_status' };

export function advanceShipment(from: ShipmentStatus, to: ShipmentStatus | null): Advance {
  if (to === null) return { apply: false, reason: 'not_a_status' };
  if (to === 'unknown') return { apply: false, reason: 'unknown_status' };
  if (to === from) return { apply: false, reason: 'duplicate' };
  return NEXT[from].includes(to) ? { apply: true } : { apply: false, reason: 'out_of_order' };
}

export const isFinalShipmentStatus = (s: ShipmentStatus): boolean =>
  NEXT[s].length === 0 && s !== 'unknown';
/** Statuses in which the booking can still be cancelled with the courier. */
export const isCancellable = (s: ShipmentStatus): boolean => s === 'booked';
