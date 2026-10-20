import {
  ORDER_SOURCES,
  normalizeBdPhone,
  normalizeDivision,
  DIVISIONS,
  type Division,
  type OrderSource,
} from '@orderloop/contracts';
import { parseCount, parseMoney, text, type RowError } from './catalog-import.js';
import { CsvError, parseCsvRecords, type CsvRecord } from './csv.js';
import { ORDER_LIMITS } from './orders.js';
import { normalizeSku } from './sku.js';

export const ORDER_IMPORT_LIMITS = {
  maxBytes: 2_000_000,
  maxRows: 5000,
  maxOrders: 500,
  maxErrors: 100,
} as const;

/** Columns an orders CSV may contain. One row per order line; rows sharing an `order_ref` are one order. */
export const ORDER_IMPORT_COLUMNS = [
  'order_ref',
  'customer_name',
  'phone',
  'recipient_name',
  'address_line',
  'area',
  'district',
  'division',
  'postal_code',
  'sku',
  'quantity',
  'unit_price',
  'line_discount',
  'discount',
  'delivery_charge',
  'advance_paid',
  'source',
  'source_reference',
  'notes',
] as const;
const REQUIRED = [
  'order_ref',
  'customer_name',
  'phone',
  'address_line',
  'area',
  'district',
  'division',
  'sku',
  'quantity',
] as const;

export interface ParsedOrderLine {
  row: number;
  sku: string;
  quantity: number;
  /** Null means "use the catalog price". */
  unitPriceMinor: number | null;
  discountMinor: number;
}

export interface ParsedOrder {
  ref: string;
  /** The line of the file where the order starts; problems with the order as a whole are reported here. */
  row: number;
  customerName: string;
  phone: string;
  recipientName: string;
  line1: string;
  area: string;
  district: string;
  division: Division;
  postalCode: string | null;
  items: ParsedOrderLine[];
  discountMinor: number;
  deliveryChargeMinor: number;
  advancePaidMinor: number;
  source: OrderSource;
  sourceReference: string | null;
  notes: string | null;
}

export interface ParsedOrdersCsv {
  orders: ParsedOrder[];
  errors: RowError[];
  fatal: string | null;
  totalRows: number;
  /** Orders in the file, good or bad. */
  orderCount: number;
}

type Rec = Record<string, string>;

/**
 * Validate and group an orders CSV. Pure: no database, so it cannot know whether a SKU exists (the API checks that).
 * Problems are collected per line so one bad row does not hide the rest; an order with any bad line is left out whole, so
 * a half-imported order is never created. Totals are never read from the file: they are worked out from quantities and
 * prices by the server.
 */
export function parseOrdersCsv(input: string): ParsedOrdersCsv {
  const fail = (fatal: string): ParsedOrdersCsv => ({
    orders: [],
    errors: [],
    fatal,
    totalRows: 0,
    orderCount: 0,
  });
  if (new TextEncoder().encode(input).length > ORDER_IMPORT_LIMITS.maxBytes)
    return fail(`The file is larger than ${ORDER_IMPORT_LIMITS.maxBytes / 1_000_000} MB`);
  let table: CsvRecord[];
  try {
    table = parseCsvRecords(input);
  } catch (error) {
    return fail(error instanceof CsvError ? error.message : 'The file is not valid CSV');
  }
  if (table.length === 0) return fail('The file is empty');
  const header = table[0]!.fields.map((h) => h.trim().toLowerCase());
  const unknown = header.filter(
    (h) => h !== '' && !(ORDER_IMPORT_COLUMNS as readonly string[]).includes(h),
  );
  if (unknown.length)
    return fail(
      `Unknown column(s): ${unknown.join(', ')}. Allowed: ${ORDER_IMPORT_COLUMNS.join(', ')}`,
    );
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) return fail(`Missing required column(s): ${missing.join(', ')}`);
  if (new Set(header).size !== header.length) return fail('A column appears more than once');
  const body = table.slice(1);
  if (body.length === 0) return fail('The file has a header but no rows');
  if (body.length > ORDER_IMPORT_LIMITS.maxRows)
    return fail(`The file has more than ${ORDER_IMPORT_LIMITS.maxRows} rows`);

  const errors: RowError[] = [];
  const groups = new Map<string, { row: number; lines: { row: number; rec: Rec }[] }>();
  body.forEach(({ fields: record, line: row }) => {
    if (record.length > header.length) {
      errors.push({ row, message: 'The row has more fields than the header (unquoted comma?)' });
      return;
    }
    const rec: Rec = {};
    header.forEach((h, i) => (rec[h] = (record[i] ?? '').trim()));
    const ref = rec['order_ref'] ?? '';
    if (!ref) {
      errors.push({
        row,
        message: 'order_ref is required (rows with the same order_ref are one order)',
      });
      return;
    }
    if (ref.length > 60) {
      errors.push({ row, message: 'order_ref is longer than 60 characters' });
      return;
    }
    const group = groups.get(ref) ?? { row, lines: [] };
    group.lines.push({ row, rec });
    groups.set(ref, group);
  });

  if (groups.size > ORDER_IMPORT_LIMITS.maxOrders)
    return fail(
      `The file has more than ${ORDER_IMPORT_LIMITS.maxOrders} orders. Split it into smaller files.`,
    );

  const orders: ParsedOrder[] = [];
  for (const [ref, group] of groups) {
    const problems: RowError[] = [];
    const bad = (row: number, message: string) => problems.push({ row, message });
    const first = group.lines[0]!;

    // Customer, address and order-level values: given on the first line, optionally repeated, never contradicted.
    const shared = (column: string): string => {
      const values = new Set(group.lines.map((l) => l.rec[column] ?? '').filter((v) => v !== ''));
      if (values.size > 1) {
        const second = group.lines.find(
          (l) => (l.rec[column] ?? '') !== '' && l.rec[column] !== [...values][0],
        )!;
        bad(second.row, `${column} differs between the lines of order ${ref}`);
      }
      return [...values][0] ?? '';
    };
    const need = (column: string, label = column): string => {
      const v = shared(column);
      if (!v) bad(first.row, `${label} is required for order ${ref}`);
      return v;
    };

    const customerName = need('customer_name');
    const phoneRaw = need('phone');
    const phone = phoneRaw ? normalizeBdPhone(phoneRaw) : null;
    if (phoneRaw && !phone)
      bad(first.row, 'phone is not a Bangladeshi mobile number like 01712-345678');
    const line1 = need('address_line');
    const area = need('area');
    const district = need('district');
    const divisionRaw = need('division');
    const division = normalizeDivision(divisionRaw);
    if (divisionRaw && !division) bad(first.row, `division must be one of ${DIVISIONS.join(', ')}`);

    const guard = <T>(row: number, fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (error) {
        bad(row, error instanceof Error ? error.message : 'Invalid value');
        return fallback;
      }
    };
    const money = (column: string, max: number = ORDER_LIMITS.maxMoney): number => {
      const v = shared(column);
      return v === ''
        ? 0
        : guard(
            first.row,
            () => {
              const n = parseMoney(v, column);
              if (n > max) throw new RangeError(`${column} is too large`);
              return n;
            },
            0,
          );
    };
    const discountMinor = money('discount');
    const deliveryChargeMinor = money('delivery_charge', ORDER_LIMITS.maxDeliveryCharge);
    const advancePaidMinor = money('advance_paid');
    const sourceRaw = shared('source')
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    const source = (sourceRaw === '' ? 'other' : sourceRaw) as OrderSource;
    if (!(ORDER_SOURCES as readonly string[]).includes(source))
      bad(first.row, `source must be one of ${ORDER_SOURCES.join(', ')}`);
    const postalRaw = shared('postal_code');
    if (postalRaw && !/^\d{4}$/.test(postalRaw)) bad(first.row, 'postal_code is 4 digits');
    const recipient = shared('recipient_name') || customerName;
    const sourceReference = guard(
      first.row,
      () => text(shared('source_reference'), 'source_reference', 200),
      null,
    );
    const notes = guard(first.row, () => text(shared('notes'), 'notes', 1000), null);
    if (customerName.length > 100) bad(first.row, 'customer_name is longer than 100 characters');
    if (customerName.length === 1) bad(first.row, 'customer_name must be at least 2 characters');
    if (line1.length > 200) bad(first.row, 'address_line is longer than 200 characters');
    if (area.length > 100 || district.length > 100)
      bad(first.row, 'area or district is longer than 100 characters');

    const seenSku = new Set<string>();
    const items: ParsedOrderLine[] = [];
    for (const { row, rec } of group.lines) {
      const sku = normalizeSku(rec['sku'] ?? '');
      if (!sku) {
        bad(row, 'sku is missing or not valid');
        continue;
      }
      if (seenSku.has(sku)) {
        bad(row, `sku ${sku} appears twice in order ${ref}`);
        continue;
      }
      seenSku.add(sku);
      const q = rec['quantity'] ?? '';
      const quantity = guard(
        row,
        () => {
          const n = parseCount(q, 'quantity', ORDER_LIMITS.maxQuantity);
          if (n < 1) throw new RangeError('quantity must be at least 1');
          return n;
        },
        0,
      );
      const price = rec['unit_price'] ?? '';
      const unitPriceMinor =
        price === '' ? null : guard(row, () => parseMoney(price, 'unit_price'), null);
      const disc = rec['line_discount'] ?? '';
      const lineDiscount = disc === '' ? 0 : guard(row, () => parseMoney(disc, 'line_discount'), 0);
      items.push({ row, sku, quantity, unitPriceMinor, discountMinor: lineDiscount });
    }
    if (items.length > ORDER_LIMITS.maxLines)
      bad(first.row, `An order can have at most ${ORDER_LIMITS.maxLines} items`);

    if (problems.length) errors.push(...problems);
    else
      orders.push({
        ref,
        row: first.row,
        customerName,
        phone: phone!,
        recipientName: recipient,
        line1,
        area,
        district,
        division: division!,
        postalCode: postalRaw || null,
        items,
        discountMinor,
        deliveryChargeMinor,
        advancePaidMinor,
        source,
        sourceReference,
        notes,
      });
  }
  errors.sort((a, b) => a.row - b.row);
  return { orders, errors, fatal: null, totalRows: body.length, orderCount: groups.size };
}
