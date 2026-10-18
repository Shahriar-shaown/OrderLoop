import { z } from 'zod';
import { Uuid } from './auth.js';
import { IdempotencyKey } from './catalog.js';
import { CourierProvider } from './couriers.js';

// ---- vocabulary -------------------------------------------------------------------------------------------------------

export const MATCH_STATUS_VALUES = [
  'matched',
  'unmatched',
  'ambiguous',
  'unallocated',
  'duplicate',
  'ignored',
] as const;
export const SettlementMatchStatus = z.enum(MATCH_STATUS_VALUES);
export type SettlementMatchStatus = z.infer<typeof SettlementMatchStatus>;

export const MATCH_METHOD_VALUES = [
  'consignment_id',
  'tracking_code',
  'reference',
  'order_number',
  'manual',
] as const;
export const SettlementMatchMethod = z.enum(MATCH_METHOD_VALUES);

export const SettlementKind = z.enum(['cod', 'return', 'adjustment']);

export const DISCREPANCY_TYPE_VALUES = [
  'short_paid',
  'over_paid',
  'cash_before_delivery',
  'cash_on_closed_order',
  'fee_differs',
  'file_arithmetic',
] as const;
export const DiscrepancyType = z.enum(DISCREPANCY_TYPE_VALUES);
export type DiscrepancyType = z.infer<typeof DiscrepancyType>;

export const DiscrepancyStatus = z.enum(['open', 'resolved', 'waived']);

export const COST_KIND_VALUES = [
  'packaging',
  'advertising',
  'delivery_charge',
  'return_charge',
  'courier_deduction',
  'other',
] as const;
export const CostKind = z.enum(COST_KIND_VALUES);
export type CostKind = z.infer<typeof CostKind>;

export const CashState = z.enum([
  'paid',
  'partial',
  'unpaid',
  'overpaid',
  'awaiting_delivery',
  'not_due',
  'cash_before_delivery',
  'cash_on_closed_order',
]);
export type CashState = z.infer<typeof CashState>;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Minor = z.number().int();
const Reason = z.string().trim().min(3, 'Say why (at least 3 characters)').max(300);

// ---- import -----------------------------------------------------------------------------------------------------------

export const SettlementImportBody = z.object({
  provider: CourierProvider,
  /** The statement as CSV text. See docs/settlements.md for the columns. */
  csv: z.string().min(1).max(2_500_000),
  fileName: z.string().trim().max(200).optional(),
  statementRef: z.string().trim().max(100).optional(),
  /** Check the file and show what would happen, without recording anything. */
  dryRun: z.boolean().default(false),
});
export type SettlementImportBody = z.infer<typeof SettlementImportBody>;

export const SettlementCounts = z.object({
  matched: z.number().int(),
  unmatched: z.number().int(),
  ambiguous: z.number().int(),
  unallocated: z.number().int(),
  duplicate: z.number().int(),
  ignored: z.number().int(),
});
export type SettlementCounts = z.infer<typeof SettlementCounts>;

export const SettlementTotals = z.object({
  /** Cash the courier says it collected, in lines that are not duplicates or ignored. */
  collectedMinor: Minor,
  /** Everything the courier kept: delivery, COD fee, return and other deductions. */
  chargesMinor: Minor,
  /** collected - charges: what the courier pays out for these lines. */
  netMinor: Minor,
});
export type SettlementTotals = z.infer<typeof SettlementTotals>;

export const Discrepancy = z.object({
  id: Uuid,
  type: DiscrepancyType,
  status: DiscrepancyStatus,
  itemId: Uuid.nullable(),
  shipmentId: Uuid.nullable(),
  orderId: Uuid.nullable(),
  orderNumber: z.number().int().nullable(),
  expectedMinor: Minor.nullable(),
  actualMinor: Minor.nullable(),
  message: z.string(),
  resolution: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Discrepancy = z.infer<typeof Discrepancy>;

export const SettlementItem = z.object({
  id: Uuid,
  batchId: Uuid,
  lineNo: z.number().int(),
  kind: SettlementKind,
  transactionId: z.string().nullable(),
  consignmentId: z.string().nullable(),
  trackingCode: z.string().nullable(),
  reference: z.string().nullable(),
  phone: z.string().nullable(),
  date: Day,
  collectedMinor: Minor,
  deliveryChargeMinor: Minor,
  codFeeMinor: Minor,
  returnChargeMinor: Minor,
  otherDeductionMinor: Minor,
  netMinor: Minor,
  /** COD due on the matched order, when matched. */
  expectedMinor: Minor.nullable(),
  fileNetMinor: Minor.nullable(),
  note: z.string().nullable(),
  matchStatus: SettlementMatchStatus,
  matchMethod: SettlementMatchMethod.nullable(),
  matchNote: z.string().nullable(),
  orderId: Uuid.nullable(),
  orderNumber: z.number().int().nullable(),
  shipmentId: Uuid.nullable(),
  duplicateOfId: Uuid.nullable(),
  /** Open discrepancies about this line or about its parcel's total. */
  discrepancies: z.array(Discrepancy),
});
export type SettlementItem = z.infer<typeof SettlementItem>;

export const BatchStatus = z.enum(['reconciled', 'needs_attention', 'ready']);
export type BatchStatus = z.infer<typeof BatchStatus>;

export const SettlementBatch = z.object({
  id: Uuid,
  provider: CourierProvider,
  fileName: z.string().nullable(),
  statementRef: z.string().nullable(),
  rowCount: z.number().int(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  reconciledAt: z.string().nullable(),
  /** `reconciled` only after an explicit reconcile with nothing outstanding; `needs_attention` while anything is unmatched or in doubt. */
  status: BatchStatus,
  counts: SettlementCounts,
  openDiscrepancies: z.number().int(),
  totals: SettlementTotals,
  /** COD of the orders this statement's matched lines cover (each order once). */
  expectedMinor: Minor,
  /** Cash the statement reports for those orders, less the COD expected: negative means short. */
  differenceMinor: Minor,
});
export type SettlementBatch = z.infer<typeof SettlementBatch>;

export const SettlementBatchDetail = SettlementBatch.extend({
  items: z.array(SettlementItem),
  /** Plain reasons the batch cannot be reconciled yet. Empty when it can. */
  issues: z.array(z.string()),
  canReconcile: z.boolean(),
});
export type SettlementBatchDetail = z.infer<typeof SettlementBatchDetail>;

export const SettlementImportResult = z.object({
  dryRun: z.boolean(),
  /** True when this exact file was imported before: nothing was added. */
  alreadyImported: z.boolean(),
  batchId: Uuid.nullable(),
  rows: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
  fatal: z.string().nullable(),
  counts: SettlementCounts,
  totals: SettlementTotals,
  discrepancies: z.number().int(),
});
export type SettlementImportResult = z.infer<typeof SettlementImportResult>;

export const SettlementItemHistory = z.object({
  id: Uuid,
  action: z.string(),
  actorName: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export const SettlementItemDetail = SettlementItem.extend({
  history: z.array(SettlementItemHistory),
});
export type SettlementItemDetail = z.infer<typeof SettlementItemDetail>;

export const ManualMatchBody = z.object({ shipmentId: Uuid, reason: Reason });
export const ReasonBody = z.object({ reason: Reason });
export const ResolveDiscrepancyBody = z.object({
  /** `resolve`: the difference is explained or fixed. `waive`: the difference is accepted as a loss. */
  action: z.enum(['resolve', 'waive']),
  note: Reason,
});

export const DiscrepancyQuery = z.object({ status: DiscrepancyStatus.optional() });
export const BatchListQuery = z.object({ provider: CourierProvider.optional() });

// ---- outstanding COD ---------------------------------------------------------------------------------------------------

export const OutstandingRow = z.object({
  orderId: Uuid,
  orderNumber: z.number().int(),
  provider: CourierProvider,
  shipmentId: Uuid,
  simulated: z.boolean(),
  deliveredAt: z.string().nullable(),
  ageDays: z.number().int().nullable(),
  expectedMinor: Minor,
  collectedMinor: Minor,
  outstandingMinor: Minor,
  state: CashState,
});
export type OutstandingRow = z.infer<typeof OutstandingRow>;

export const OutstandingCod = z.object({
  asOf: z.string(),
  /** COD for delivered orders that have a courier shipment. */
  deliveredExpectedMinor: Minor,
  /** Cash the couriers' statements report for those orders. */
  deliveredCollectedMinor: Minor,
  /** What couriers still owe: delivered COD with no matching statement line. Never reduced by delivery alone. */
  outstandingMinor: Minor,
  /** COD on orders still with a courier: not yet due. */
  onTheWayMinor: Minor,
  /** Delivered orders with COD but no courier shipment: cash is handled outside the system and is not tracked here. */
  untrackedDeliveredCount: z.number().int(),
  untrackedDeliveredMinor: Minor,
  byProvider: z.array(
    z.object({ provider: CourierProvider, orders: z.number().int(), outstandingMinor: Minor }),
  ),
  rows: z.array(OutstandingRow),
  /** More outstanding orders exist than are listed (oldest first). */
  truncated: z.boolean(),
});
export type OutstandingCod = z.infer<typeof OutstandingCod>;

// ---- summary ----------------------------------------------------------------------------------------------------------

export const FigureSource = z.enum([
  'orders',
  'settlements',
  'manual_costs',
  'catalog_costs',
  'derived',
]);
export const FIGURE_GROUPS = [
  'sales',
  'revenue',
  'cash',
  'outstanding',
  'expenses',
  'profit',
] as const;
export const FinanceFigure = z.object({
  key: z.string(),
  group: z.enum(FIGURE_GROUPS),
  label: z.string(),
  amountMinor: Minor,
  source: FigureSource,
  /** Plain words: where it comes from and what it leaves out. */
  note: z.string(),
});
export type FinanceFigure = z.infer<typeof FinanceFigure>;

export const ManualCostBreakdown = z.object({ kind: CostKind, amountMinor: Minor });
export const SummaryQuery = z.object({ from: Day.optional(), to: Day.optional() });
export const FinanceSummary = z.object({
  from: Day,
  to: Day,
  timezone: z.string(),
  figures: z.array(FinanceFigure),
  /** The recorded costs of the period, by kind (their total is the `manual_costs` figure). */
  manualCostsByKind: z.array(ManualCostBreakdown),
  estimatedProfitMinor: Minor.nullable(),
  profitWithheldReason: z.string().nullable(),
  /** Things a reader should know before trusting the figures. */
  caveats: z.array(z.string()),
});
export type FinanceSummary = z.infer<typeof FinanceSummary>;

// ---- manual costs -----------------------------------------------------------------------------------------------------

export const CreateCostBody = z.object({
  kind: CostKind,
  amountMinor: z.number().int().min(1).max(2_000_000_000),
  incurredOn: Day,
  orderId: Uuid.optional(),
  note: z.string().trim().min(2).max(300),
  idempotencyKey: IdempotencyKey,
});
export type CreateCostBody = z.infer<typeof CreateCostBody>;

export const ManualCost = z.object({
  id: Uuid,
  kind: CostKind,
  amountMinor: Minor,
  incurredOn: Day,
  orderId: Uuid.nullable(),
  orderNumber: z.number().int().nullable(),
  note: z.string(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  createdAt: z.string(),
});
export type ManualCost = z.infer<typeof ManualCost>;
export const CostQuery = z.object({ from: Day.optional(), to: Day.optional() });
