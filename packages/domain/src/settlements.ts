import { MAX_MINOR, normalizeBdPhone } from '@orderloop/contracts';
import { bdtToPaisa } from './money.js';
import { CsvError, parseCsvRecords, type CsvRecord } from './csv.js';

/**
 * Courier settlement rules as pure functions: reading a settlement file, matching its lines to parcels, deciding what is
 * outstanding, and working out profit. Money is whole paisa (integers) throughout; no floating point touches an amount.
 */

export const SETTLEMENT_LIMITS = { maxBytes: 2_000_000, maxRows: 2000, maxErrors: 100 } as const;

const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

export const SETTLEMENT_COLUMNS = [
  'transaction_id',
  'consignment_id',
  'tracking_code',
  'reference',
  'phone',
  'date',
  'type',
  'collected',
  'delivery_charge',
  'cod_fee',
  'return_charge',
  'other_deduction',
  'net',
  'note',
] as const;

export type SettlementKind = 'cod' | 'return' | 'adjustment';

export interface SettlementRow {
  /** Line number in the file (the header is line 1). */
  line: number;
  transactionId: string | null;
  consignmentId: string | null;
  trackingCode: string | null;
  /** Our reference (`OL-1001`) or a bare order number, as the courier printed it. */
  reference: string | null;
  phone: string | null;
  /** YYYY-MM-DD */
  date: string;
  kind: SettlementKind;
  /** Cash the courier collected from the customer for this parcel. */
  collectedMinor: number;
  deliveryChargeMinor: number;
  codFeeMinor: number;
  returnChargeMinor: number;
  otherDeductionMinor: number;
  /** What the file says it pays out for this line, when it says. */
  fileNetMinor: number | null;
  note: string | null;
}

export interface SettlementLineError {
  line: number;
  message: string;
}

export interface ParsedSettlement {
  rows: SettlementRow[];
  errors: SettlementLineError[];
  fatal: string | null;
}

/** What the courier pays us for a line: cash collected less everything it keeps. Can be negative (a return fee with no cash). */
export const settlementNet = (r: {
  collectedMinor: number;
  deliveryChargeMinor: number;
  codFeeMinor: number;
  returnChargeMinor: number;
  otherDeductionMinor: number;
}): number =>
  r.collectedMinor -
  r.deliveryChargeMinor -
  r.codFeeMinor -
  r.returnChargeMinor -
  r.otherDeductionMinor;

/** Amounts as people write them: "1,250.50", "৳1250", "Tk 850", "BDT 99.5". At most two decimals, never negative, never above the database limit. */
export function parseSettlementAmount(raw: string): number | null {
  const cleaned = raw
    .replace(/^(?:৳|bdt|tk\.?)\s*/i, '')
    .replace(/,/g, '')
    .trim();
  if (cleaned === '') return 0;
  if (cleaned.startsWith('-')) return null;
  try {
    const minor = bdtToPaisa(cleaned);
    return minor <= MAX_MINOR ? minor : null;
  } catch {
    return null;
  }
}

/** YYYY-MM-DD, or DD/MM/YYYY and DD-MM-YYYY (day first, as written in Bangladesh). Returns null for anything else or a date that does not exist. */
export function parseSettlementDate(raw: string): string | null {
  const t = raw.trim();
  let y: string, m: string, d: string;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (match) [, y, m, d] = match as unknown as string[] as [string, string, string, string];
  else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t)))
    [, d, m, y] = match as unknown as string[] as [string, string, string, string];
  else return null;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const back = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

const KIND_WORDS: Record<string, SettlementKind> = {
  cod: 'cod',
  delivered: 'cod',
  delivery: 'cod',
  collection: 'cod',
  return: 'return',
  returned: 'return',
  adjustment: 'adjustment',
  fee: 'adjustment',
  deduction: 'adjustment',
};

/**
 * Read a settlement CSV. The whole file is refused when any line is wrong (with every problem listed by line number): a
 * statement that is silently half-read would give wrong money, so nothing is guessed or skipped.
 */
export function parseSettlementCsv(input: string): ParsedSettlement {
  const fail = (fatal: string, errors: SettlementLineError[] = []): ParsedSettlement => ({
    rows: [],
    errors,
    fatal,
  });
  if (new TextEncoder().encode(input).length > SETTLEMENT_LIMITS.maxBytes)
    return fail(`The file is larger than ${SETTLEMENT_LIMITS.maxBytes / 1_000_000} MB`);
  let table: CsvRecord[];
  try {
    table = parseCsvRecords(input);
  } catch (error) {
    return fail(error instanceof CsvError ? error.message : 'The file is not valid CSV');
  }
  if (table.length === 0) return fail('The file is empty');
  const header = table[0]!.fields.map((h) => h.trim().toLowerCase());
  const unknown = header.filter(
    (h) => h !== '' && !(SETTLEMENT_COLUMNS as readonly string[]).includes(h),
  );
  if (unknown.length)
    return fail(
      `Unknown column(s): ${unknown.join(', ')}. Allowed: ${SETTLEMENT_COLUMNS.join(', ')}`,
    );
  if (new Set(header).size !== header.length) return fail('A column appears more than once');
  if (!header.includes('date')) return fail('Missing required column: date');
  if (!header.some((h) => ['consignment_id', 'tracking_code', 'reference'].includes(h)))
    return fail('The file needs at least one of: consignment_id, tracking_code, reference');
  const body = table.slice(1);
  if (body.length === 0) return fail('The file has a header but no rows');
  if (body.length > SETTLEMENT_LIMITS.maxRows)
    return fail(`The file has more than ${SETTLEMENT_LIMITS.maxRows} rows`);

  const errors: SettlementLineError[] = [];
  const rows: SettlementRow[] = [];
  body.forEach(({ fields: record, line }) => {
    const bad = (message: string) => errors.push({ line, message });
    if (record.length > header.length)
      return bad('The row has more fields than the header (unquoted comma?)');
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = (record[i] ?? '').trim()));
    const kindWord = (rec['type'] ?? '').toLowerCase();
    if (kindWord && !(kindWord in KIND_WORDS))
      return bad(`Unknown type "${rec['type']}". Use cod, return or adjustment`);
    const date = parseSettlementDate(rec['date'] ?? '');
    if (!date) return bad(`"${rec['date'] ?? ''}" is not a date. Use YYYY-MM-DD`);
    const amount = (col: string): number | null => {
      const v = parseSettlementAmount(rec[col] ?? '');
      if (v === null)
        bad(
          `${col}: "${rec[col]}" is not an amount in taka (no negatives, at most two decimals, at most ${MAX_MINOR / 100})`,
        );
      return v;
    };
    const collected = amount('collected');
    const delivery = amount('delivery_charge');
    const cod = amount('cod_fee');
    const ret = amount('return_charge');
    const other = amount('other_deduction');
    let fileNet: number | null = null;
    if ((rec['net'] ?? '') !== '') {
      const neg = rec['net']!.startsWith('-');
      const v = parseSettlementAmount(neg ? rec['net']!.slice(1) : rec['net']!);
      if (v === null) bad(`net: "${rec['net']}" is not an amount in taka`);
      else fileNet = neg ? -v : v;
    }
    if (collected === null || delivery === null || cod === null || ret === null || other === null)
      return;
    const kind: SettlementKind = kindWord ? KIND_WORDS[kindWord]! : 'cod';
    const consignmentId = rec['consignment_id'] || null;
    const trackingCode = rec['tracking_code'] || null;
    const reference = rec['reference'] || null;
    if (kind === 'cod' && (rec['collected'] ?? '') === '')
      return bad('collected is required for a cod line (write 0 if nothing was collected)');
    const net = settlementNet({
      collectedMinor: collected,
      deliveryChargeMinor: delivery,
      codFeeMinor: cod,
      returnChargeMinor: ret,
      otherDeductionMinor: other,
    });
    if (net < INT4_MIN || net > INT4_MAX)
      return bad('The amounts on the line add up to too large a net');
    if (kind !== 'adjustment' && !consignmentId && !trackingCode && !reference)
      return bad('The line names no parcel (consignment_id, tracking_code or reference)');
    if (kind === 'return' && collected > 0) return bad('A return line cannot have cash collected');
    const phone = rec['phone'] ? normalizeBdPhone(rec['phone']) : null;
    if (rec['phone'] && !phone)
      return bad(`phone: "${rec['phone']}" is not a Bangladeshi mobile number`);
    rows.push({
      line,
      transactionId: rec['transaction_id'] || null,
      consignmentId,
      trackingCode,
      reference,
      phone,
      date,
      kind,
      collectedMinor: collected,
      deliveryChargeMinor: delivery,
      codFeeMinor: cod,
      returnChargeMinor: ret,
      otherDeductionMinor: other,
      fileNetMinor: fileNet,
      note: rec['note'] || null,
    });
  });
  if (errors.length)
    return { rows: [], errors: errors.slice(0, SETTLEMENT_LIMITS.maxErrors), fatal: null };
  return { rows, errors: [], fatal: null };
}

/**
 * The text that identifies a line, so the same line is never recorded twice. A courier's own transaction id is used when the
 * file has one, together with the parcel (consignment, tracking code, reference) and the kind of line: a payout id often
 * covers many parcels, so the id alone must never make two parcels "the same". Without a transaction id every field that
 * matters is used (including the phone and the note). Lines that repeat all of that are flagged duplicate; put the reason
 * in the note to tell two genuine identical fees apart.
 */
export function settlementItemKeyMaterial(provider: string, r: SettlementRow): string {
  const parcel = [
    (r.consignmentId ?? '').toLowerCase(),
    (r.trackingCode ?? '').toLowerCase(),
    (r.reference ?? '').toLowerCase(),
    r.kind,
  ];
  if (r.transactionId) return ['tx', provider, r.transactionId.toLowerCase(), ...parcel].join('|');
  return [
    'row',
    provider,
    ...parcel,
    r.date,
    r.collectedMinor,
    r.deliveryChargeMinor,
    r.codFeeMinor,
    r.returnChargeMinor,
    r.otherDeductionMinor,
    r.phone ?? '',
    (r.note ?? '').trim().toLowerCase(),
  ].join('|');
}

// ---- matching ---------------------------------------------------------------------------------------------------------

export interface MatchCandidate {
  shipmentId: string;
  orderId: string;
  orderNumber: number;
  consignmentId: string | null;
  trackingCode: string | null;
  /** Our reference for the parcel, e.g. OL-1001 or OL-1001-2. */
  reference: string;
  shipPhone: string;
}

export type MatchMethod = 'consignment_id' | 'tracking_code' | 'reference' | 'order_number';

export type MatchDecision =
  | { outcome: 'matched'; method: MatchMethod; shipmentId: string; orderId: string }
  | { outcome: 'ambiguous'; reason: string }
  | { outcome: 'unmatched'; reason: string };

const eq = (a: string | null, b: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Decide which parcel a line is about, using only identifiers that cannot plausibly belong to something else:
 *
 *  1. the courier's consignment id, 2. the tracking code, 3. our own reference (`OL-1001`). Each names one parcel. If they
 *     name different parcels the line is **ambiguous**: it is never guessed.
 *  4. only when none of those is present, a bare order number (`1001`, `#1001`). That is weaker, so if the file also gives a
 *     phone it must agree with the order's recipient.
 *
 * A phone number alone never matches anything. Nothing here looks at amounts: a line is the same parcel whatever it pays.
 */
export function decideMatch(
  row: SettlementRow,
  candidates: readonly MatchCandidate[],
): MatchDecision {
  const strong: { method: MatchMethod; found: MatchCandidate[] }[] = [];
  if (row.consignmentId)
    strong.push({
      method: 'consignment_id',
      found: candidates.filter((c) => eq(c.consignmentId, row.consignmentId)),
    });
  if (row.trackingCode)
    strong.push({
      method: 'tracking_code',
      found: candidates.filter((c) => eq(c.trackingCode, row.trackingCode)),
    });
  const ref = row.reference?.trim() ?? '';
  const ours = /^OL-\d+(?:-\d+)?$/i.test(ref);
  if (ours)
    strong.push({ method: 'reference', found: candidates.filter((c) => eq(c.reference, ref)) });

  const hits = strong.filter((s) => s.found.length > 0);
  for (const s of hits)
    if (s.found.length > 1)
      return {
        outcome: 'ambiguous',
        reason: `More than one parcel has that ${s.method.replace('_', ' ')}`,
      };
  if (hits.length > 0) {
    const ids = new Set(hits.map((h) => h.found[0]!.shipmentId));
    if (ids.size > 1)
      return {
        outcome: 'ambiguous',
        reason: 'The identifiers on the line point at different parcels',
      };
    const first = hits[0]!;
    const c = first.found[0]!;
    // A reference that names another parcel (or an order number that is not this one) contradicts the strong id.
    const bareNumber = /^#?(\d{1,9})$/.exec(ref);
    if (
      (ours && !eq(c.reference, ref)) ||
      (!ours && bareNumber && Number(bareNumber[1]) !== c.orderNumber)
    )
      return {
        outcome: 'ambiguous',
        reason: 'The identifiers on the line point at different parcels',
      };
    return {
      outcome: 'matched',
      method: first.method,
      shipmentId: c.shipmentId,
      orderId: c.orderId,
    };
  }
  // A strong id that matches nothing is never papered over with the weaker order number.
  if (strong.length > 0)
    return {
      outcome: 'unmatched',
      reason: 'No parcel has that consignment id, tracking code or reference',
    };

  const bare = /^#?(\d{1,9})$/.exec(ref);
  if (!bare)
    return {
      outcome: 'unmatched',
      reason: ref
        ? `"${ref}" is not one of our references or an order number`
        : 'The line has no identifier we can use',
    };
  const n = Number(bare[1]);
  const found = candidates.filter((c) => c.orderNumber === n);
  if (found.length === 0)
    return {
      outcome: 'unmatched',
      reason: `No parcel was booked for order ${n} with this courier`,
    };
  const orders = new Set(found.map((f) => f.orderId));
  if (orders.size > 1)
    return { outcome: 'ambiguous', reason: `More than one order is numbered ${n}` };
  if (found.length > 1)
    return {
      outcome: 'ambiguous',
      reason: `Order ${n} has more than one parcel with this courier. Match it by hand`,
    };
  const c = found[0]!;
  if (row.phone && normalizeBdPhone(c.shipPhone) !== row.phone)
    return { outcome: 'ambiguous', reason: `The phone on the line is not the one on order ${n}` };
  return {
    outcome: 'matched',
    method: 'order_number',
    shipmentId: c.shipmentId,
    orderId: c.orderId,
  };
}

// ---- what is owed -----------------------------------------------------------------------------------------------------

export type OrderStatusName =
  | 'pending_confirmation'
  | 'confirmed'
  | 'ready_to_ship'
  | 'shipped'
  | 'in_transit'
  | 'delivered'
  | 'delivery_failed'
  | 'cancelled'
  | 'return_requested'
  | 'returned';

export type CashState =
  /** Delivered and the courier has reported exactly the COD amount. */
  | 'paid'
  /** Delivered, and the courier has reported some of the COD amount but not all of it. */
  | 'partial'
  /** Delivered, and no remittance has been recorded. A delivered order is NOT proof that cash arrived. */
  | 'unpaid'
  /** More cash reported than the order asked for. */
  | 'overpaid'
  /** Still with the courier; nothing is due yet. */
  | 'awaiting_delivery'
  /** Cancelled or returned: nothing is due. */
  | 'not_due'
  /** Cash was reported for an order that is not delivered. Needs a person to look. */
  | 'cash_before_delivery'
  /** Cash was reported for a cancelled or returned order. */
  | 'cash_on_closed_order';

export interface CashPosition {
  state: CashState;
  expectedMinor: number;
  collectedMinor: number;
  /** COD the courier still owes for a delivered order. Zero for anything else. */
  outstandingMinor: number;
  /** Cash reported beyond what was expected. */
  excessMinor: number;
}

const ON_THE_WAY: OrderStatusName[] = ['ready_to_ship', 'shipped', 'in_transit'];
const CLOSED: OrderStatusName[] = ['cancelled', 'returned', 'return_requested'];

/**
 * Where an order's cash stands. `collectedMinor` is the cash couriers have *reported* in matched settlement lines (not
 * remittances we have verified in a bank). Only a delivered order can have COD outstanding; everything else is explained
 * by its own state.
 */
export function cashPosition(input: {
  status: OrderStatusName;
  codAmountMinor: number;
  collectedMinor: number;
}): CashPosition {
  const { status, codAmountMinor: expected, collectedMinor: collected } = input;
  const base = { expectedMinor: expected, collectedMinor: collected };
  const excess = Math.max(0, collected - expected);
  if (status === 'delivered') {
    if (collected > expected)
      return { ...base, state: 'overpaid', outstandingMinor: 0, excessMinor: excess };
    if (collected === expected && expected > 0)
      return { ...base, state: 'paid', outstandingMinor: 0, excessMinor: 0 };
    if (expected === 0)
      return {
        ...base,
        state: collected > 0 ? 'overpaid' : 'paid',
        outstandingMinor: 0,
        excessMinor: excess,
      };
    return {
      ...base,
      state: collected === 0 ? 'unpaid' : 'partial',
      outstandingMinor: expected - collected,
      excessMinor: 0,
    };
  }
  if (CLOSED.includes(status))
    return {
      ...base,
      state: collected > 0 ? 'cash_on_closed_order' : 'not_due',
      outstandingMinor: 0,
      excessMinor: collected,
    };
  if (collected > 0)
    return { ...base, state: 'cash_before_delivery', outstandingMinor: 0, excessMinor: 0 };
  return {
    ...base,
    state: ON_THE_WAY.includes(status) ? 'awaiting_delivery' : 'not_due',
    outstandingMinor: 0,
    excessMinor: 0,
  };
}

// ---- profit -----------------------------------------------------------------------------------------------------------

export type FigureSource =
  | 'orders'
  | 'settlements'
  | 'manual_costs'
  | 'manual_receipts'
  | 'catalog_costs'
  | 'derived';

export interface FinanceFigure {
  key: string;
  label: string;
  amountMinor: number;
  source: FigureSource;
  /** Plain words: where it comes from and what it leaves out. */
  note: string;
}

export interface ProfitInput {
  goodsRevenueMinor: number;
  deliveryBilledMinor: number;
  /** Cost of goods for the delivered lines, or null when any delivered line has no cost price. */
  cogsMinor: number | null;
  courierChargesMinor: number;
  manualCostsMinor: number;
  writtenOffMinor: number;
}

export interface ProfitResult {
  /** Null when it cannot be worked out. We say why instead of showing a wrong number. */
  estimatedProfitMinor: number | null;
  withheldReason: string | null;
  incomeMinor: number;
  costsMinor: number | null;
}

const safe = (n: number) => {
  if (!Number.isSafeInteger(n)) throw new RangeError('Amount out of range');
  return n;
};

/**
 * THE definition of revenue, used by the dashboard, the finance summary and analytics: goods (item prices less every
 * discount, line and order level) plus the delivery charge billed, on orders that are delivered.
 */
export const revenueMinor = (goodsMinor: number, deliveryBilledMinor: number): number =>
  safe(goodsMinor + deliveryBilledMinor);

/**
 * THE definition of gross profit: revenue less the cost of goods. Courier charges and recorded costs come off later (see
 * `calculateProfit`). Null when the cost of goods is unknown.
 */
export const grossProfitMinor = (revenue: number, cogsMinor: number | null): number | null =>
  cogsMinor === null ? null : safe(revenue - cogsMinor);

/**
 * Courier charges are summed from imported statements, so a cost entered by hand under a courier-charge kind (only old
 * rows can have one) counts only while no statement charge covers the period: the same charge is never counted twice.
 */
export const MANUAL_COURIER_COST_KINDS: readonly string[] = [
  'delivery_charge',
  'return_charge',
  'courier_deduction',
];
export const countedManualCostsMinor = (
  byKind: readonly { kind: string; amountMinor: number }[],
  statementCourierChargesMinor: number,
): number =>
  byKind
    .filter(
      (c) => statementCourierChargesMinor === 0 || !MANUAL_COURIER_COST_KINDS.includes(c.kind),
    )
    .reduce((n, c) => safe(n + c.amountMinor), 0);

/**
 * Estimated profit = (goods revenue + delivery charges billed to customers) − cost of goods − courier charges − other
 * recorded costs − COD shortfalls written off. It is an estimate: cash is not involved, only what the records say.
 */
export function calculateProfit(i: ProfitInput): ProfitResult {
  const income = safe(i.goodsRevenueMinor + i.deliveryBilledMinor);
  if (i.cogsMinor === null)
    return {
      estimatedProfitMinor: null,
      withheldReason:
        'Some delivered order lines have no cost price, so the cost of goods is unknown.',
      incomeMinor: income,
      costsMinor: null,
    };
  const costs = safe(i.cogsMinor + i.courierChargesMinor + i.manualCostsMinor + i.writtenOffMinor);
  return {
    estimatedProfitMinor: safe(income - costs),
    withheldReason: null,
    incomeMinor: income,
    costsMinor: costs,
  };
}
