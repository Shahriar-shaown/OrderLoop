import { z } from 'zod';
import { Uuid } from './auth.js';
import { ORDER_STATUS_VALUES, OrderStatus } from './orders.js';

export const DASHBOARD_PERIODS = ['today', '7d', '30d'] as const;
export const DashboardPeriod = z.enum(DASHBOARD_PERIODS);
export type DashboardPeriod = z.infer<typeof DashboardPeriod>;

export const DashboardQuery = z.object({ period: DashboardPeriod.default('7d') });
export type DashboardQuery = z.infer<typeof DashboardQuery>;

const Count = z.number().int().min(0);
const Money = z.number().int();

/**
 * Every figure is worked out by the server from the business's own orders, stock and history. Orders are counted by when
 * they were CREATED, in the business's own time zone. "Today" is the business's calendar day, not UTC.
 */
export const Dashboard = z.object({
  period: DashboardPeriod,
  /** First and last calendar day of the period (YYYY-MM-DD, business time zone). */
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
  generatedAt: z.string(),
  orders: z.object({
    /** Orders created in the period. */
    total: Count,
    /** Current status of those orders. Every status is present, zeros included. */
    byStatus: z.object(
      Object.fromEntries(ORDER_STATUS_VALUES.map((s) => [s, Count])) as Record<
        (typeof ORDER_STATUS_VALUES)[number],
        typeof Count
      >,
    ),
  }),
  /**
   * Work waiting for a person, counted over ALL orders (not just the period): an order left pending last week still needs
   * confirming today.
   */
  attention: z.object({
    pendingConfirmation: Count,
    /** confirmed + ready_to_ship */
    toShip: Count,
    deliveryFailed: Count,
    returnsOpen: Count,
  }),
  /** Where the period's orders are in delivery. */
  delivery: z.object({
    /** shipped + in_transit */
    inProgress: Count,
    delivered: Count,
    failed: Count,
    /** return_requested */
    returnsOpen: Count,
    returned: Count,
    /** delivered / (delivered + delivery_failed + returned). Null until at least one of those exists. */
    successRate: z.number().min(0).max(1).nullable(),
  }),
  sales: z.object({
    /** Total of orders in the period that were not cancelled (item totals - discounts + delivery charges). */
    orderedMinor: Money,
    /** Total of the period's orders that have been delivered. */
    deliveredMinor: Money,
    /** Cash the couriers should collect on orders that are out for delivery now (shipped or in transit). */
    codOutForDeliveryMinor: Money,
    /** Orders counted in `orderedMinor`. */
    ordersCounted: Count,
    /** orderedMinor / ordersCounted, rounded to whole paisa. Null when there are no orders. */
    averageOrderMinor: Money.nullable(),
  }),
  /** One entry per calendar day of the period, including days with no orders. */
  daily: z.array(z.object({ date: z.string(), orders: Count, orderedMinor: Money })),
  lowStock: z.object({
    /** Active variants at or below their reorder point (all locations together). */
    count: Count,
    items: z.array(
      z.object({
        variantId: Uuid,
        sku: z.string(),
        productName: z.string(),
        variantName: z.string(),
        available: z.number().int(),
        reorderPoint: z.number().int(),
      }),
    ),
  }),
  /**
   * An ESTIMATE of gross profit on the period's delivered orders: item revenue minus the cost price recorded on each line
   * when it was sold. It is shown only when every delivered line has a cost price; otherwise `available` is false and the
   * reason says what is missing. It leaves out order-level discounts, delivery charges, courier fees, returns and taxes.
   * `null` for roles without `finance:read`: cost and profit are finance data.
   */
  profit: z
    .discriminatedUnion('available', [
      z.object({
        available: z.literal(true),
        kind: z.literal('estimate'),
        basis: z.string(),
        revenueMinor: Money,
        costMinor: Money,
        grossProfitMinor: Money,
        deliveredOrders: Count,
        lines: Count,
      }),
      z.object({
        available: z.literal(false),
        reason: z.string(),
        linesWithCost: Count,
        lines: Count,
      }),
    ])
    .nullable(),
  /** The latest status changes across all orders (any time), newest first. */
  recentActivity: z.array(
    z.object({
      id: Uuid,
      at: z.string(),
      orderId: Uuid,
      orderNumber: z.number().int(),
      fromStatus: OrderStatus.nullable(),
      toStatus: OrderStatus,
      actorName: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});
export type Dashboard = z.infer<typeof Dashboard>;
