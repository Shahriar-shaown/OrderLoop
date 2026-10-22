import { MAX_MINOR } from '@orderloop/contracts';

/**
 * Order rules as pure functions: the state machine, what each transition does to stock, the totals, and Bangladeshi phone
 * numbers. The API enforces exactly these (and the database backs the money identities with CHECK constraints); the
 * web and mobile apps use the same functions to show a preview, but only ever display the server's figures once saved.
 */

// ---- status -----------------------------------------------------------------------------------------------------------

/**
 * Names follow the product brief. The architecture's DRAFT / PACKED / HANDED_OVER are the same steps under these names:
 * pending_confirmation (DRAFT), ready_to_ship (PACKED), shipped (HANDED_OVER). delivery_failed and the two return states
 * are added because a Bangladeshi COD shop has to track failed deliveries and returns explicitly.
 */
export const ORDER_STATUSES = [
  'pending_confirmation',
  'confirmed',
  'ready_to_ship',
  'shipped',
  'in_transit',
  'delivered',
  'delivery_failed',
  'cancelled',
  'return_requested',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Allowed next states. Anything not listed is refused. `cancelled` and `returned` are final. */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending_confirmation: ['confirmed', 'cancelled'],
  confirmed: ['ready_to_ship', 'cancelled'],
  ready_to_ship: ['shipped', 'cancelled'],
  // Once handed over the goods have left: no cancelling, only the delivery outcome.
  shipped: ['in_transit', 'delivered', 'delivery_failed'],
  in_transit: ['delivered', 'delivery_failed'],
  // A failed delivery can be retried, or turned into a return.
  delivery_failed: ['in_transit', 'return_requested'],
  delivered: ['return_requested'],
  // A return can be declined (back to delivered) or completed.
  return_requested: ['returned', 'delivered'],
  returned: [],
  cancelled: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  ORDER_TRANSITIONS[from].includes(to);

export const isFinalStatus = (status: OrderStatus): boolean =>
  ORDER_TRANSITIONS[status].length === 0;

/**
 * Orders in these statuses are still being worked on, so the customer's details are still needed: a customer who has one
 * cannot be erased (`erase_blocked`). The same list is written into the SQL function `erase_customer`.
 */
export const IN_PROGRESS_STATUSES: readonly OrderStatus[] = ORDER_STATUSES.filter(
  (s) => s !== 'delivered' && s !== 'cancelled' && s !== 'returned',
);

/** Statuses a person can only reach by giving a reason (it is stored in the status history). */
export const REASON_REQUIRED: readonly OrderStatus[] = [
  'cancelled',
  'delivery_failed',
  'return_requested',
  'returned',
];

/** What a transition does to inventory. The only moments stock moves for an order. */
export type StockEffect = 'reserve' | 'release' | 'ship' | 'restock' | 'none';

/**
 * - reserve: pending_confirmation -> confirmed. Not before: an unconfirmed chat order holds no stock.
 * - release: confirmed or ready_to_ship -> cancelled. The held units become available again.
 * - ship: ready_to_ship -> shipped. The reserved units leave (a SHIP movement).
 * - restock: return_requested -> returned. The goods come back, resaleable or damaged.
 * Everything else leaves stock alone.
 */
export function stockEffect(from: OrderStatus, to: OrderStatus): StockEffect {
  if (from === 'pending_confirmation' && to === 'confirmed') return 'reserve';
  if ((from === 'confirmed' || from === 'ready_to_ship') && to === 'cancelled') return 'release';
  if (from === 'ready_to_ship' && to === 'shipped') return 'ship';
  if (from === 'return_requested' && to === 'returned') return 'restock';
  return 'none';
}

/** While an order is in one of these it owns active reservations. */
export const holdsStock = (status: OrderStatus): boolean =>
  status === 'confirmed' || status === 'ready_to_ship';

/** What may still be edited in each status. Lines and money are frozen once stock is held. */
export type EditScope = 'full' | 'contact' | 'notes' | 'none';
export function editScope(status: OrderStatus): EditScope {
  if (status === 'pending_confirmation') return 'full';
  if (status === 'confirmed' || status === 'ready_to_ship') return 'contact';
  if (isFinalStatus(status)) return 'none';
  return 'notes';
}

// ---- totals -----------------------------------------------------------------------------------------------------------

export const ORDER_LIMITS = {
  maxLines: 100,
  maxQuantity: 10_000,
  maxMoney: MAX_MINOR,
  maxDeliveryCharge: 100_000_000,
} as const;

export class OrderTotalsError extends Error {
  constructor(
    message: string,
    /** The input the problem is about, for field errors: "lines.2.quantity", "discountMinor", ... */
    readonly field: string,
  ) {
    super(message);
    this.name = 'OrderTotalsError';
  }
}

export interface OrderLineInput {
  quantity: number;
  unitPriceMinor: number;
  discountMinor?: number;
}

export interface OrderTotalsInput {
  lines: readonly OrderLineInput[];
  /** Taken off the subtotal. */
  discountMinor?: number;
  deliveryChargeMinor?: number;
  /** Already paid (an advance). Cash on delivery is whatever is left. */
  advancePaidMinor?: number;
}

export interface OrderTotals {
  lineTotalsMinor: number[];
  subtotalMinor: number;
  discountMinor: number;
  deliveryChargeMinor: number;
  totalMinor: number;
  advancePaidMinor: number;
  /** What the courier collects: total minus the advance. Always computed, never typed in. */
  codAmountMinor: number;
}

const isMoney = (n: number, max: number): boolean => Number.isSafeInteger(n) && n >= 0 && n <= max;

/**
 *   line total = quantity x unit price - line discount
 *   subtotal   = sum of line totals
 *   total      = subtotal - discount + delivery charge
 *   COD amount = total - advance paid
 *
 * Whole paisa throughout (no floats). Throws OrderTotalsError naming the input at fault. Nothing here trusts a total from
 * a client: callers pass quantities, prices and the three adjustments, and receive every derived figure.
 */
export function calculateOrderTotals(input: OrderTotalsInput): OrderTotals {
  const { lines } = input;
  if (lines.length === 0) throw new OrderTotalsError('An order needs at least one item', 'lines');
  if (lines.length > ORDER_LIMITS.maxLines)
    throw new OrderTotalsError(`An order can have at most ${ORDER_LIMITS.maxLines} items`, 'lines');

  const lineTotalsMinor = lines.map((line, i) => {
    const at = `lines.${i}`;
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > ORDER_LIMITS.maxQuantity
    )
      throw new OrderTotalsError(
        `Quantity must be a whole number from 1 to ${ORDER_LIMITS.maxQuantity}`,
        `${at}.quantity`,
      );
    if (!isMoney(line.unitPriceMinor, ORDER_LIMITS.maxMoney))
      throw new OrderTotalsError(
        'Price must be a whole number of paisa, 0 or more',
        `${at}.unitPriceMinor`,
      );
    const gross = line.quantity * line.unitPriceMinor;
    if (gross > ORDER_LIMITS.maxMoney)
      throw new OrderTotalsError('This line is too large', `${at}.quantity`);
    const discount = line.discountMinor ?? 0;
    if (!isMoney(discount, ORDER_LIMITS.maxMoney))
      throw new OrderTotalsError(
        'Discount must be a whole number of paisa, 0 or more',
        `${at}.discountMinor`,
      );
    if (discount > gross)
      throw new OrderTotalsError(
        'A line discount cannot be more than the line amount',
        `${at}.discountMinor`,
      );
    return gross - discount;
  });

  const subtotalMinor = lineTotalsMinor.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor > ORDER_LIMITS.maxMoney)
    throw new OrderTotalsError('The order is too large', 'lines');

  const discountMinor = input.discountMinor ?? 0;
  if (!isMoney(discountMinor, ORDER_LIMITS.maxMoney))
    throw new OrderTotalsError(
      'Discount must be a whole number of paisa, 0 or more',
      'discountMinor',
    );
  if (discountMinor > subtotalMinor)
    throw new OrderTotalsError('The discount cannot be more than the items total', 'discountMinor');

  const deliveryChargeMinor = input.deliveryChargeMinor ?? 0;
  if (!isMoney(deliveryChargeMinor, ORDER_LIMITS.maxDeliveryCharge))
    throw new OrderTotalsError(
      'Delivery charge must be a whole number of paisa, 0 or more',
      'deliveryChargeMinor',
    );

  const totalMinor = subtotalMinor - discountMinor + deliveryChargeMinor;
  if (totalMinor > ORDER_LIMITS.maxMoney)
    throw new OrderTotalsError('The order is too large', 'lines');

  const advancePaidMinor = input.advancePaidMinor ?? 0;
  if (!isMoney(advancePaidMinor, ORDER_LIMITS.maxMoney))
    throw new OrderTotalsError(
      'Advance must be a whole number of paisa, 0 or more',
      'advancePaidMinor',
    );
  if (advancePaidMinor > totalMinor)
    throw new OrderTotalsError(
      'The advance cannot be more than the order total',
      'advancePaidMinor',
    );

  return {
    lineTotalsMinor,
    subtotalMinor,
    discountMinor,
    deliveryChargeMinor,
    totalMinor,
    advancePaidMinor,
    codAmountMinor: totalMinor - advancePaidMinor,
  };
}

// ---- phone numbers ----------------------------------------------------------------------------------------------------

// The rules live in contracts (forms validate with them); re-exported here so domain code has one place to import from.
export { formatBdPhone, normalizeBdPhone } from '@orderloop/contracts';
