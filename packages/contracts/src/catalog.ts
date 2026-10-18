import { z } from 'zod';
import { Uuid } from './auth.js';

// SKU rules mirror normalizeSku in @orderloop/domain (a domain test keeps the two in step); contracts depends on nothing.
const SKU_RE = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
export const SKU_RULE =
  'Use 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit';

export const UNITS = ['pcs', 'kg', 'g', 'l', 'ml', 'm', 'pack', 'dozen'] as const;
export const Unit = z.enum(UNITS);
export type Unit = z.infer<typeof Unit>;

/** Money is integer paisa (1 BDT = 100 paisa), never a decimal. Capped well inside a 32-bit integer. */
export const PriceMinor = z.number().int().min(0).max(2_000_000_000);

const Name = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), 'Contains characters that are not allowed');
export const Sku = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(SKU_RE, SKU_RULE));
const Quantity = z.number().int().min(1).max(1_000_000);
export const IdempotencyKey = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits and . _ : -');
const Reference = {
  referenceType: z.string().trim().min(1).max(40).optional(),
  referenceId: z.string().trim().min(1).max(100).optional(),
};
const Cursor = z.string().max(200).optional();
const Limit = z.coerce.number().int().min(1).max(100).default(50);
const BoolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

// ---- categories -----------------------------------------------------------------------------------------------------
export const CategoryBody = z.object({ name: Name(100) });
export type CategoryBody = z.infer<typeof CategoryBody>;
export const Category = z.object({ id: Uuid, name: z.string() });
export type Category = z.infer<typeof Category>;

// ---- suppliers ------------------------------------------------------------------------------------------------------
const OptionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
export const SupplierBody = z.object({
  name: Name(150),
  contactName: OptionalText(100),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'Enter a valid phone number')
    .nullable()
    .optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address')
    .max(254)
    .nullable()
    .optional(),
  address: OptionalText(300),
  notes: OptionalText(1000),
});
export type SupplierBody = z.infer<typeof SupplierBody>;
export const SupplierUpdate = SupplierBody.partial().extend({ archived: z.boolean().optional() });
export type SupplierUpdate = z.infer<typeof SupplierUpdate>;
export const Supplier = z.object({
  id: Uuid,
  name: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  archived: z.boolean(),
});
export type Supplier = z.infer<typeof Supplier>;

// ---- products and variants ------------------------------------------------------------------------------------------
const Attributes = z
  .record(z.string().min(1).max(40), z.string().max(100))
  .refine((o) => Object.keys(o).length <= 10, 'At most 10 attributes');

export const VariantInput = z.object({
  sku: Sku,
  name: z.string().trim().max(100).default(''),
  attributes: Attributes.default({}),
  priceMinor: PriceMinor,
  costMinor: PriceMinor.nullable().optional(),
  barcode: z.string().trim().min(1).max(64).nullable().optional(),
  reorderPoint: z.number().int().min(0).max(1_000_000).default(0),
});
export type VariantInput = z.infer<typeof VariantInput>;

/** The SKU is deliberately absent: it never changes once created. */
export const VariantUpdate = z.object({
  name: z.string().trim().max(100).optional(),
  attributes: Attributes.optional(),
  priceMinor: PriceMinor.optional(),
  costMinor: PriceMinor.nullable().optional(),
  barcode: z.string().trim().min(1).max(64).nullable().optional(),
  reorderPoint: z.number().int().min(0).max(1_000_000).optional(),
  archived: z.boolean().optional(),
});
export type VariantUpdate = z.infer<typeof VariantUpdate>;

export const StockTotals = z.object({
  onHand: z.number().int(),
  reserved: z.number().int(),
  /** onHand - reserved. Damaged stock is separate and never available. */
  available: z.number().int(),
  damaged: z.number().int(),
});
export type StockTotals = z.infer<typeof StockTotals>;

export const Variant = z.object({
  id: Uuid,
  productId: Uuid,
  sku: z.string(),
  name: z.string(),
  attributes: z.record(z.string(), z.string()),
  priceMinor: z.number().int(),
  costMinor: z.number().int().nullable(),
  barcode: z.string().nullable(),
  reorderPoint: z.number().int(),
  archived: z.boolean(),
  /** Summed over all locations. */
  stock: StockTotals,
});
export type Variant = z.infer<typeof Variant>;

export const ProductStatus = z.enum(['ACTIVE', 'ARCHIVED']);
export type ProductStatus = z.infer<typeof ProductStatus>;

/** Picture links. Only https, so a page served over https never loads mixed content. Pictures are not uploaded yet. */
export const ImageUrls = z
  .array(
    z
      .string()
      .trim()
      .max(2048, 'Link is too long')
      .url('Enter a valid link')
      .refine((v) => v.startsWith('https://'), 'Picture links must start with https://'),
  )
  .max(8, 'At most 8 pictures');

export const ProductBody = z.object({
  name: Name(200),
  description: z.string().trim().max(2000).optional(),
  categoryId: Uuid.optional(),
  supplierId: Uuid.optional(),
  imageUrls: ImageUrls.default([]),
  unit: Unit.default('pcs'),
  variants: z.array(VariantInput).min(1, 'A product needs at least one variant').max(50),
});
export type ProductBody = z.infer<typeof ProductBody>;

export const ProductUpdate = z.object({
  name: Name(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  categoryId: Uuid.nullable().optional(),
  supplierId: Uuid.nullable().optional(),
  imageUrls: ImageUrls.optional(),
  unit: Unit.optional(),
  status: ProductStatus.optional(),
});
export type ProductUpdate = z.infer<typeof ProductUpdate>;

export const Product = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  categoryId: Uuid.nullable(),
  supplierId: Uuid.nullable(),
  imageUrls: z.array(z.string()),
  unit: Unit,
  status: ProductStatus,
  createdAt: z.string(),
  variants: z.array(Variant),
});
export type Product = z.infer<typeof Product>;

export const ProductQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  categoryId: Uuid.optional(),
  status: ProductStatus.optional(),
  cursor: Cursor,
  limit: Limit,
});
export type ProductQuery = z.infer<typeof ProductQuery>;
export const ProductPage = z.object({ items: z.array(Product), nextCursor: z.string().nullable() });
export type ProductPage = z.infer<typeof ProductPage>;

// ---- stock locations ------------------------------------------------------------------------------------------------
export const LocationBody = z.object({ name: Name(100), isDefault: z.boolean().optional() });
export type LocationBody = z.infer<typeof LocationBody>;
export const LocationUpdate = z.object({
  name: Name(100).optional(),
  isDefault: z.literal(true).optional(),
  archived: z.boolean().optional(),
});
export type LocationUpdate = z.infer<typeof LocationUpdate>;
export const Location = z.object({
  id: Uuid,
  name: z.string(),
  isDefault: z.boolean(),
  archived: z.boolean(),
});
export type Location = z.infer<typeof Location>;

// ---- inventory ------------------------------------------------------------------------------------------------------
export const StockLine = z.object({
  variantId: Uuid,
  sku: z.string(),
  productName: z.string(),
  variantName: z.string(),
  locationId: Uuid,
  locationName: z.string(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  damaged: z.number().int(),
  reorderPoint: z.number().int(),
});
export type StockLine = z.infer<typeof StockLine>;

export const InventoryQuery = z.object({
  variantId: Uuid.optional(),
  locationId: Uuid.optional(),
  lowStock: BoolQuery.optional(),
  cursor: Cursor,
  limit: Limit,
});
export type InventoryQuery = z.infer<typeof InventoryQuery>;
export const InventoryPage = z.object({
  items: z.array(StockLine),
  nextCursor: z.string().nullable(),
});
export type InventoryPage = z.infer<typeof InventoryPage>;

export const ReceiveBody = z.object({
  variantId: Uuid,
  /** Defaults to the tenant's default location. */
  locationId: Uuid.optional(),
  quantity: Quantity,
  reason: z.string().trim().max(200).optional(),
  /** Send the same key when retrying a request; the retry then changes nothing and returns the original result. */
  idempotencyKey: IdempotencyKey.optional(),
  ...Reference,
});
export type ReceiveBody = z.infer<typeof ReceiveBody>;

export const AdjustBody = z.object({
  variantId: Uuid,
  locationId: Uuid.optional(),
  /** Signed change to the on-hand count (a stock-take correction, damage, loss). */
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((n) => n !== 0, 'delta cannot be 0'),
  reason: z.string().trim().min(3, 'Say why').max(200),
  idempotencyKey: IdempotencyKey.optional(),
});
export type AdjustBody = z.infer<typeof AdjustBody>;

/** Move sellable units to the damaged bucket (broken, spoiled, water-damaged). Needs a reason; cannot cut into reserved stock. */
export const DamageBody = z.object({
  variantId: Uuid,
  locationId: Uuid.optional(),
  quantity: Quantity,
  reason: z.string().trim().min(3, 'Say what happened').max(200),
  idempotencyKey: IdempotencyKey.optional(),
});
export type DamageBody = z.infer<typeof DamageBody>;

/** Dispose of damaged units for good. */
export const WriteOffBody = DamageBody;
export type WriteOffBody = z.infer<typeof WriteOffBody>;

/**
 * Units coming back from a customer, for the returns workflow. `idempotencyKey` is required: the same return processed
 * twice (a retry, a duplicate webhook) must add the units once. Use a key derived from the return, such as
 * `return:<returnId>:<variantId>`.
 */
export const ReturnBody = z.object({
  variantId: Uuid,
  locationId: Uuid.optional(),
  quantity: Quantity,
  condition: z.enum(['RESALEABLE', 'DAMAGED']),
  reason: z.string().trim().max(200).optional(),
  idempotencyKey: IdempotencyKey,
  ...Reference,
});
export type ReturnBody = z.infer<typeof ReturnBody>;

export const StockChange = z.object({
  movementId: Uuid,
  variantId: Uuid,
  locationId: Uuid,
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  damaged: z.number().int(),
});
export type StockChange = z.infer<typeof StockChange>;

export const MovementType = z.enum([
  'RECEIVE',
  'ADJUSTMENT',
  'RESERVE',
  'RELEASE',
  'SHIP',
  'DAMAGE',
  'WRITE_OFF',
  'RETURN',
]);
export type MovementType = z.infer<typeof MovementType>;
export const Movement = z.object({
  id: Uuid,
  type: MovementType,
  variantId: Uuid,
  sku: z.string(),
  locationId: Uuid,
  onHandDelta: z.number().int(),
  reservedDelta: z.number().int(),
  damagedDelta: z.number().int(),
  reason: z.string().nullable(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  reservationId: Uuid.nullable(),
  createdById: Uuid.nullable(),
  createdAt: z.string(),
});
export type Movement = z.infer<typeof Movement>;
export const MovementQuery = z.object({
  variantId: Uuid.optional(),
  locationId: Uuid.optional(),
  type: MovementType.optional(),
  cursor: Cursor,
  limit: Limit,
});
export type MovementQuery = z.infer<typeof MovementQuery>;
export const MovementPage = z.object({
  items: z.array(Movement),
  nextCursor: z.string().nullable(),
});
export type MovementPage = z.infer<typeof MovementPage>;

export const LowStockItem = z.object({
  variantId: Uuid,
  sku: z.string(),
  productName: z.string(),
  variantName: z.string(),
  reorderPoint: z.number().int(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  damaged: z.number().int(),
});
export type LowStockItem = z.infer<typeof LowStockItem>;

// ---- reservations ---------------------------------------------------------------------------------------------------
export const ReservationStatus = z.enum(['ACTIVE', 'RELEASED', 'FULFILLED']);
export type ReservationStatus = z.infer<typeof ReservationStatus>;
export const ReservationBody = z.object({
  variantId: Uuid,
  locationId: Uuid.optional(),
  quantity: Quantity,
  idempotencyKey: IdempotencyKey.optional(),
  ...Reference,
});
export type ReservationBody = z.infer<typeof ReservationBody>;
export const Reservation = z.object({
  id: Uuid,
  variantId: Uuid,
  locationId: Uuid,
  quantity: z.number().int(),
  status: ReservationStatus,
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Reservation = z.infer<typeof Reservation>;
export const ReservationQuery = z.object({
  status: ReservationStatus.optional(),
  variantId: Uuid.optional(),
  cursor: Cursor,
  limit: Limit,
});
export type ReservationQuery = z.infer<typeof ReservationQuery>;
export const ReservationPage = z.object({
  items: z.array(Reservation),
  nextCursor: z.string().nullable(),
});
export type ReservationPage = z.infer<typeof ReservationPage>;

// ---- imports --------------------------------------------------------------------------------------------------------
export const ImportBody = z.object({
  /** The CSV text. Columns: product_name, sku, price (required); category, unit, variant_name, size, colour, cost, reorder_point, barcode, description, supplier, opening_stock, location. */
  csv: z.string().min(1).max(2_000_000),
});
export type ImportBody = z.infer<typeof ImportBody>;
export const ImportStatus = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']);
export type ImportStatus = z.infer<typeof ImportStatus>;
export const ImportJob = z.object({
  id: Uuid,
  kind: z.string(),
  status: ImportStatus,
  totalRows: z.number().int().nullable(),
  created: z.number().int(),
  updated: z.number().int(),
  failed: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type ImportJob = z.infer<typeof ImportJob>;

/**
 * What an import would do, worked out without changing anything. Show it, let the person fix the file, and only then
 * start the import. `errors` lists the first 100 problems; `errorCount` is the real total.
 */
export const ImportPreview = z.object({
  /** Set when the file cannot be used at all (bad header, too large). Then the other counts are zero. */
  fatal: z.string().nullable(),
  totalRows: z.number().int(),
  /** Rows that would be applied. */
  validRows: z.number().int(),
  willCreate: z.number().int(),
  willUpdate: z.number().int(),
  errorCount: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

/** A CSV file produced by the API; the client saves it. */
export const CsvExport = z.object({
  filename: z.string(),
  rowCount: z.number().int(),
  csv: z.string(),
});
export type CsvExport = z.infer<typeof CsvExport>;
