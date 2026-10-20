import { MAX_MINOR } from '@orderloop/contracts';
import { bdtToPaisa } from './money.js';
import { CsvError, parseCsvRecords, type CsvRecord } from './csv.js';
import { nameKey, normalizeSku, SKU_RULE } from './sku.js';

export const UNITS = ['pcs', 'kg', 'g', 'l', 'ml', 'm', 'pack', 'dozen'] as const;
export type Unit = (typeof UNITS)[number];

export const IMPORT_LIMITS = { maxBytes: 2_000_000, maxRows: 5000, maxErrors: 100 } as const;

/** Columns a catalog CSV may contain. `product_name`, `sku` and `price` are required. */
export const IMPORT_COLUMNS = [
  'product_name',
  'sku',
  'price',
  'category',
  'unit',
  'variant_name',
  'size',
  'colour',
  'cost',
  'reorder_point',
  'barcode',
  'description',
  'supplier',
  'opening_stock',
  'location',
] as const;
const REQUIRED = ['product_name', 'sku', 'price'] as const;

export interface ImportRow {
  /** 1-based line number in the file (the header is line 1). */
  row: number;
  productName: string;
  category: string | null;
  unit: Unit;
  sku: string;
  variantName: string;
  priceMinor: number;
  costMinor: number | null;
  reorderPoint: number;
  barcode: string | null;
  description: string | null;
  size: string | null;
  colour: string | null;
  supplier: string | null;
  openingStock: number;
  location: string | null;
}

export interface RowError {
  row: number;
  message: string;
}

export interface ParsedImport {
  rows: ImportRow[];
  errors: RowError[];
  /** Set when the file cannot be processed at all (bad header, too large, malformed CSV). */
  fatal: string | null;
  totalRows: number;
}

export function parseMoney(raw: string, label: string): number {
  let minor: number;
  try {
    minor = bdtToPaisa(raw.replace(/^৳/, '').trim());
  } catch {
    throw new RangeError(
      `${label} must be a non-negative amount with at most 2 decimals, like 1250 or 1250.50`,
    );
  }
  if (minor < 0)
    throw new RangeError(`${label} must be a non-negative amount, like 1250 or 1250.50`);
  if (minor > MAX_MINOR) throw new RangeError(`${label} is too large`);
  return minor;
}

export function parseCount(raw: string, label: string, max: number): number {
  if (!/^\d+$/.test(raw.trim()))
    throw new RangeError(`${label} must be a whole number of 0 or more`);
  const n = Number(raw.trim());
  if (n > max) throw new RangeError(`${label} must be at most ${max}`);
  return n;
}

export function text(raw: string | undefined, label: string, max: number): string | null {
  const value = (raw ?? '').trim();
  if (value.length > max) throw new RangeError(`${label} is longer than ${max} characters`);
  return value === '' ? null : value;
}

/**
 * Validate and normalise a product catalog CSV. Pure: no database. Row-level problems are collected per row so one bad
 * line does not hide the rest; file-level problems set `fatal`.
 */
export function parseCatalogCsv(input: string): ParsedImport {
  const fail = (fatal: string): ParsedImport => ({ rows: [], errors: [], fatal, totalRows: 0 });
  if (new TextEncoder().encode(input).length > IMPORT_LIMITS.maxBytes) {
    return fail(`The file is larger than ${IMPORT_LIMITS.maxBytes / 1_000_000} MB`);
  }
  let table: CsvRecord[];
  try {
    table = parseCsvRecords(input);
  } catch (error) {
    return fail(error instanceof CsvError ? error.message : 'The file is not valid CSV');
  }
  if (table.length === 0) return fail('The file is empty');

  // American spelling is accepted for the colour column.
  const header = table[0]!.fields.map((h) => {
    const name = h.trim().toLowerCase();
    return name === 'color' ? 'colour' : name;
  });
  const unknown = header.filter(
    (h) => h !== '' && !(IMPORT_COLUMNS as readonly string[]).includes(h),
  );
  if (unknown.length)
    return fail(`Unknown column(s): ${unknown.join(', ')}. Allowed: ${IMPORT_COLUMNS.join(', ')}`);
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) return fail(`Missing required column(s): ${missing.join(', ')}`);
  if (new Set(header).size !== header.length) return fail('A column appears more than once');

  const body = table.slice(1);
  if (body.length === 0) return fail('The file has a header but no rows');
  if (body.length > IMPORT_LIMITS.maxRows)
    return fail(`The file has more than ${IMPORT_LIMITS.maxRows} rows`);

  const col = (record: string[], name: string) => {
    const i = header.indexOf(name);
    return i === -1 ? undefined : record[i];
  };

  const rows: ImportRow[] = [];
  const errors: RowError[] = [];
  const seenSku = new Map<string, number>();
  const productShape = new Map<string, { unit: Unit; category: string | null; row: number }>();

  body.forEach(({ fields: record, line: row }) => {
    try {
      if (record.length > header.length)
        throw new RangeError('The row has more fields than the header (unquoted comma?)');
      const productName = text(col(record, 'product_name'), 'product_name', 200);
      if (!productName) throw new RangeError('product_name is required');
      const sku = normalizeSku(col(record, 'sku') ?? '');
      if (!sku) throw new RangeError(`sku is invalid. ${SKU_RULE}`);
      const firstRow = seenSku.get(sku);
      if (firstRow !== undefined)
        throw new RangeError(`sku ${sku} is repeated (first on line ${firstRow})`);

      const size = text(col(record, 'size'), 'size', 100);
      const colour = text(col(record, 'colour'), 'colour', 100);
      // A variant with a size or colour but no label is called "Red / M", as the product form does.
      const variantName =
        text(col(record, 'variant_name'), 'variant_name', 100) ??
        [colour, size].filter(Boolean).join(' / ');
      const unitRaw = (text(col(record, 'unit'), 'unit', 20) ?? 'pcs').toLowerCase();
      if (!(UNITS as readonly string[]).includes(unitRaw))
        throw new RangeError(`unit must be one of ${UNITS.join(', ')}`);
      const category = text(col(record, 'category'), 'category', 100);

      const priceRaw = (col(record, 'price') ?? '').trim();
      if (priceRaw === '') throw new RangeError('price is required');
      const costRaw = (col(record, 'cost') ?? '').trim();
      const reorderRaw = (col(record, 'reorder_point') ?? '').trim();
      const openingRaw = (col(record, 'opening_stock') ?? '').trim();

      const parsed: ImportRow = {
        row,
        productName,
        category,
        unit: unitRaw as Unit,
        sku,
        variantName: variantName,
        size,
        colour,
        supplier: text(col(record, 'supplier'), 'supplier', 150),
        priceMinor: parseMoney(priceRaw, 'price'),
        costMinor: costRaw === '' ? null : parseMoney(costRaw, 'cost'),
        reorderPoint: reorderRaw === '' ? 0 : parseCount(reorderRaw, 'reorder_point', 1_000_000),
        barcode: text(col(record, 'barcode'), 'barcode', 64),
        description: text(col(record, 'description'), 'description', 2000),
        openingStock: openingRaw === '' ? 0 : parseCount(openingRaw, 'opening_stock', 1_000_000),
        location: text(col(record, 'location'), 'location', 100),
      };

      // Rows of one product must agree on what the product is.
      const key = nameKey(productName);
      const shape = productShape.get(key);
      if (
        shape &&
        (shape.unit !== parsed.unit || (shape.category ?? '') !== (parsed.category ?? ''))
      ) {
        throw new RangeError(
          `unit or category differs from line ${shape.row}, which is also "${productName}"`,
        );
      }
      if (!shape) productShape.set(key, { unit: parsed.unit, category: parsed.category, row });

      seenSku.set(sku, row);
      rows.push(parsed);
    } catch (error) {
      errors.push({ row, message: error instanceof Error ? error.message : 'Invalid row' });
    }
  });

  return { rows, errors, fatal: null, totalRows: body.length };
}
