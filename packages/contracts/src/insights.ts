import { z } from 'zod';
import { Uuid } from './auth.js';
import { CourierEnvironment, CourierProvider, ShipmentStatus } from './couriers.js';
import { CashState } from './finance.js';
import { Day } from './day.js';
import { OrderSource, OrderStatus, PaymentState } from './orders.js';

const Minor = z.number().int();
const CommaList = <T extends z.ZodEnum<Record<string, string>>>(item: T) =>
  z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).min(1).max(20));

// ---- order list extras ----------------------------------------------------------------------------------------------------

// ---- the cash on one order --------------------------------------------------------------------------------------------------

export const OrderCash = z.object({
  state: CashState,
  expectedMinor: Minor,
  /** Cash couriers' statements report for this order (matched lines only). */
  collectedMinor: Minor,
  /** What couriers kept, per those lines. */
  chargesMinor: Minor,
  /** collected − charges: what the courier pays out for this order. */
  netMinor: Minor,
  outstandingMinor: Minor,
  /** True when the order has a real (not simulated) courier shipment, so a statement could confirm its cash. */
  hasCourierShipment: z.boolean(),
  lines: z.number().int(),
});
export type OrderCash = z.infer<typeof OrderCash>;

// ---- shipments across orders ------------------------------------------------------------------------------------------------

export const ShipmentQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: CommaList(ShipmentStatus).optional(),
  provider: CourierProvider.optional(),
  /** Only parcels with cash to collect. */
  codOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  from: Day.optional(),
  to: Day.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ShipmentQuery = z.infer<typeof ShipmentQuery>;

export const ShipmentRow = z.object({
  id: Uuid,
  orderId: Uuid,
  orderNumber: z.number().int(),
  customerName: z.string(),
  provider: CourierProvider,
  environment: CourierEnvironment,
  simulated: z.boolean(),
  status: ShipmentStatus,
  providerStatus: z.string().nullable(),
  consignmentId: z.string().nullable(),
  reference: z.string(),
  trackingCode: z.string().nullable(),
  codAmountMinor: Minor,
  deliveryFeeMinor: Minor.nullable(),
  bookedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type ShipmentRow = z.infer<typeof ShipmentRow>;

export const ShipmentRowPage = z.object({
  items: z.array(ShipmentRow),
  total: z.number().int(),
  page: z.number().int(),
  pages: z.number().int(),
  /** How many parcels are in each status for the same search (ignoring the status filter), for the status chips. */
  statusCounts: z.record(z.string(), z.number().int()),
});
export type ShipmentRowPage = z.infer<typeof ShipmentRowPage>;

export const CourierStats = z.object({
  provider: CourierProvider,
  simulated: z.boolean(),
  shipments: z.number().int(),
  delivered: z.number().int(),
  /** delivered ÷ (delivered + failed + returned). Null until one of those exists. */
  deliveredRate: z.number().nullable(),
  /** Average days from booking to delivery, over delivered parcels that have both dates. */
  avgDeliveryDays: z.number().nullable(),
});
export const ShipmentSummary = z.object({
  /** The windows the figures cover. */
  recentDays: z.number().int(),
  statsDays: z.number().int(),
  bookedToday: z.number().int(),
  /** Booked, not yet picked up. */
  awaitingPickup: z.number().int(),
  /** Picked up, in transit or out for delivery. */
  onTheWay: z.number().int(),
  /** Booked more than 3 days ago and still not delivered, failed or returned. */
  delayed: z.number().int(),
  delivered: z.number().int(),
  returned: z.number().int(),
  /** COD on real parcels that are on the way (never simulated ones). */
  codOnTheWayMinor: Minor,
  codOnTheWayCount: z.number().int(),
  providers: z.array(CourierStats),
});
export type ShipmentSummary = z.infer<typeof ShipmentSummary>;

// ---- inventory summary ------------------------------------------------------------------------------------------------------

export const InventorySummary = z.object({
  products: z.number().int(),
  variants: z.number().int(),
  /** Σ on hand × cost price, over variants that have a cost. */
  inventoryValueCostMinor: Minor,
  /** Σ on hand × selling price. */
  retailValueMinor: Minor,
  /** Variants with stock but no cost price (left out of the cost value). */
  missingCostVariants: z.number().int(),
  lowStockCount: z.number().int(),
  outOfStockCount: z.number().int(),
});
export type InventorySummary = z.infer<typeof InventorySummary>;

// ---- analytics --------------------------------------------------------------------------------------------------------------

export const AnalyticsQuery = z.object({
  from: Day.optional(),
  to: Day.optional(),
  source: OrderSource.optional(),
});
export const AnalyticsDay = z.object({
  date: Day,
  /** Goods + delivery billed on orders delivered that day. */
  revenueMinor: Minor,
  /** Revenue − cost of goods, before courier charges and other costs. Null if a delivered line that day has no cost. */
  grossProfitMinor: Minor.nullable(),
});
export const AnalyticsChannel = z.object({
  source: OrderSource,
  orders: z.number().int(),
  revenueMinor: Minor,
});
export const AnalyticsProduct = z.object({
  productName: z.string(),
  variantName: z.string(),
  sku: z.string(),
  units: z.number().int(),
  revenueMinor: Minor,
  costMinor: Minor.nullable(),
  grossProfitMinor: Minor.nullable(),
});
export const Analytics = z.object({
  from: Day,
  to: Day,
  timezone: z.string(),
  daily: z.array(AnalyticsDay),
  channels: z.array(AnalyticsChannel),
  topProducts: z.array(AnalyticsProduct),
  /** All delivered lines, so the table can show "other products" and a total. */
  totalUnits: z.number().int(),
  totalRevenueMinor: Minor,
  totalCostMinor: Minor.nullable(),
  deliveredOrders: z.number().int(),
  /** Orders created in the period, not cancelled: how many and their value. */
  placedOrders: z.number().int(),
  placedMinor: Minor,
  /** Value of placed orders that are not delivered (in progress, returned, failed). */
  notDeliveredMinor: Minor,
  averageOrderMinor: Minor.nullable(),
  /** delivered ÷ (delivered + failed + returned) over orders created in the period. */
  deliverySuccessRate: z.number().nullable(),
  statusCounts: z.record(z.string(), z.number().int()),
  /** Delivered lines with no cost price, whose cost (and so profit) is unknown. */
  linesWithoutCost: z.number().int(),
});
export type Analytics = z.infer<typeof Analytics>;
export { OrderStatus, PaymentState };
