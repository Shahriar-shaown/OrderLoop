import { z } from 'zod';
import { Email, Uuid } from './auth.js';
import { IdempotencyKey, PriceMinor } from './catalog.js';
import { OptionalIdempotencyKey } from './idempotency.js';
import { CourierProvider, ShipmentStatus } from './couriers.js';
import { Day } from './day.js';
import { normalizeBdPhone } from './phone.js';

// ---- vocabulary -------------------------------------------------------------------------------------------------------

/** Mirrors ORDER_STATUSES in @orderloop/domain (a domain test keeps the two in step); contracts depends on nothing. */
export const ORDER_STATUS_VALUES = [
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
export const OrderStatus = z.enum(ORDER_STATUS_VALUES);
export type OrderStatus = z.infer<typeof OrderStatus>;

/** Where an order came from. */
export const ORDER_SOURCES = [
  'facebook',
  'instagram',
  'whatsapp',
  'phone_call',
  'website',
  'walk_in',
  'other',
] as const;
export const OrderSource = z.enum(ORDER_SOURCES);
export type OrderSource = z.infer<typeof OrderSource>;

export const DIVISIONS = [
  'Barishal',
  'Chattogram',
  'Dhaka',
  'Khulna',
  'Mymensingh',
  'Rajshahi',
  'Rangpur',
  'Sylhet',
] as const;
export type Division = (typeof DIVISIONS)[number];

/** Other common spellings of the divisions, written lower case without spaces or punctuation. */
const DIVISION_ALIASES: Record<string, Division> = {
  barisal: 'Barishal',
  chittagong: 'Chattogram',
  chattagram: 'Chattogram',
  chittagram: 'Chattogram',
  dacca: 'Dhaka',
  mymensing: 'Mymensingh',
  sylet: 'Sylhet',
};

/** The division a person meant ("chittagong", "Dhaka Division", "BARISAL"), or null when it is not one of the eight. */
export function normalizeDivision(input: string): Division | null {
  const key = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/division$/, '');
  return DIVISIONS.find((d) => d.toLowerCase() === key) ?? DIVISION_ALIASES[key] ?? null;
}

/** Accepts the common spellings and stores the canonical name. */
export const Division = z
  .string()
  .transform((v) => normalizeDivision(v) ?? v)
  .pipe(z.enum(DIVISIONS));

const CONTROL = /[\p{Cc}\p{Cf}]/u;
/** Like CONTROL, but a line break and a tab are fine: free text such as notes and addresses is often pasted with them. */
const CONTROL_EXCEPT_WHITESPACE = /(?![\n\r\t])[\p{Cc}\p{Cf}]/u;

/** Single-line text for names and labels, or with `multiline` free text that may contain line breaks and tabs. */
const text = (label: string, max: number, multiline = false) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine(
      (v) => !(multiline ? CONTROL_EXCEPT_WHITESPACE : CONTROL).test(v),
      `${label} contains characters that are not allowed`,
    );
const optionalText = (label: string, max: number, multiline = false) =>
  text(label, max, multiline).nullable().optional();

/** A Bangladeshi mobile number, accepted in any common spelling and stored as +8801XXXXXXXXX. */
export const BdPhone = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .transform((v, ctx) => {
    const phone = normalizeBdPhone(v);
    if (!phone) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter a Bangladeshi mobile number like 01712-345678',
      });
      return z.NEVER;
    }
    return phone;
  });

// ---- customers and addresses -------------------------------------------------------------------------------------------

export const AddressFields = z.object({
  recipientName: text('Recipient name', 100),
  phone: BdPhone,
  line1: text('Address', 200, true),
  area: text('Thana or upazila', 100),
  district: text('District', 100),
  division: Division,
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'Postal code is 4 digits')
    .nullable()
    .optional(),
});
export type AddressFields = z.infer<typeof AddressFields>;

export const AddressBody = AddressFields.extend({
  label: optionalText('Label', 40),
  isDefault: z.boolean().optional(),
});
export type AddressBody = z.infer<typeof AddressBody>;
export const CreateAddressBody = AddressBody.extend(OptionalIdempotencyKey);
export type CreateAddressBody = z.infer<typeof CreateAddressBody>;
export const AddressUpdate = AddressBody.partial();
export type AddressUpdate = z.infer<typeof AddressUpdate>;

export const AddressRecord = z.object({
  id: Uuid,
  label: z.string().nullable(),
  recipientName: z.string(),
  phone: z.string(),
  line1: z.string(),
  area: z.string(),
  district: z.string(),
  division: z.string(),
  postalCode: z.string().nullable(),
  isDefault: z.boolean(),
});
export type AddressRecord = z.infer<typeof AddressRecord>;

export const CustomerFields = z.object({
  name: text('Name', 100).refine((v) => v.length >= 2, 'Name must be at least 2 characters'),
  phone: BdPhone,
  email: Email.nullable().optional(),
  notes: optionalText('Notes', 1000, true),
});
export const CustomerBody = CustomerFields.extend(OptionalIdempotencyKey);
export type CustomerBody = z.infer<typeof CustomerBody>;
export const CustomerUpdate = CustomerFields.partial().refine(
  (v) => Object.keys(v).length > 0,
  'Nothing to update',
);
export type CustomerUpdate = z.infer<typeof CustomerUpdate>;

/**
 * Plain counts of what happened, for the person taking the next order. There is deliberately no score, rating, flag or
 * label: OrderLoop never classifies a customer (as risky, fraudulent or anything else) on its own.
 */
export const CustomerStats = z.object({
  ordersCount: z.number().int(),
  deliveredCount: z.number().int(),
  cancelledCount: z.number().int(),
  returnedCount: z.number().int(),
  /** Total of delivered orders, in paisa. */
  deliveredValueMinor: z.number().int(),
  lastOrderAt: z.string().nullable(),
});
export type CustomerStats = z.infer<typeof CustomerStats>;

export const Customer = z.object({
  id: Uuid,
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  /** Set once the customer's personal data was erased: the name, phone and the rest are placeholders and cannot be changed. */
  erasedAt: z.string().nullable(),
  stats: CustomerStats,
});
export type Customer = z.infer<typeof Customer>;
export const CustomerDetail = Customer.extend({ addresses: z.array(AddressRecord) });
export type CustomerDetail = z.infer<typeof CustomerDetail>;

export const CustomerQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type CustomerQuery = z.infer<typeof CustomerQuery>;
export const CustomerPage = z.object({
  items: z.array(Customer),
  nextCursor: z.string().nullable(),
});
export type CustomerPage = z.infer<typeof CustomerPage>;

export const AddressParams = z.object({ id: Uuid, addressId: Uuid });

// ---- orders -----------------------------------------------------------------------------------------------------------

const Quantity = z.number().int().min(1, 'Quantity must be at least 1').max(10_000);

/**
 * One line. The price is optional: left out, the server uses the variant's current price. A different price (a negotiated
 * one) is allowed and recorded on the line. Line totals are never sent; the server works them out.
 */
export const OrderItemInput = z.object({
  variantId: Uuid,
  quantity: Quantity,
  unitPriceMinor: PriceMinor.optional(),
  discountMinor: PriceMinor.optional(),
});
export type OrderItemInput = z.infer<typeof OrderItemInput>;

const Items = z.array(OrderItemInput).min(1, 'An order needs at least one item').max(100);

const Adjustments = {
  discountMinor: PriceMinor.optional(),
  deliveryChargeMinor: PriceMinor.max(100_000_000).optional(),
  /** Already paid. COD is the total minus this; it is never sent. */
  advancePaidMinor: PriceMinor.optional(),
};

const SourceFields = {
  source: OrderSource.optional(),
  sourceReference: optionalText('Source reference', 200, true),
  notes: optionalText('Notes', 1000, true),
};

export const CreateOrderBody = z
  .object({
    /** An existing customer, or the details of a new one (matched on phone number, never duplicated). */
    customerId: Uuid.optional(),
    customer: z
      .object({
        name: CustomerFields.shape.name,
        phone: BdPhone,
        email: Email.nullable().optional(),
      })
      .optional(),
    /** One of the customer's saved addresses, or an address typed in. */
    addressId: Uuid.optional(),
    address: AddressFields.optional(),
    /** With a typed-in address: also save it to the customer's address book. Default true. */
    saveAddress: z.boolean().optional(),
    items: Items,
    ...Adjustments,
    ...SourceFields,
    /** Confirm at once: reserve the stock in the same transaction. Otherwise the order waits for confirmation. */
    confirm: z.boolean().optional(),
    /** Required. Retrying a request with the same key returns the order already made instead of making another. */
    idempotencyKey: IdempotencyKey,
  })
  // A total, subtotal or COD amount in the request is refused loudly, not quietly ignored: they are the server's to work out.
  .strict()
  .superRefine((v, ctx) => {
    if (!v.customerId && !v.customer)
      ctx.addIssue({
        code: 'custom',
        path: ['customer'],
        message: 'Choose a customer or enter their details',
      });
    if (v.customerId && v.customer)
      ctx.addIssue({
        code: 'custom',
        path: ['customer'],
        message: 'Send either customerId or customer, not both',
      });
    if (!v.addressId && !v.address)
      ctx.addIssue({
        code: 'custom',
        path: ['address'],
        message: 'A delivery address is required',
      });
    if (v.addressId && v.address)
      ctx.addIssue({
        code: 'custom',
        path: ['address'],
        message: 'Send either addressId or address, not both',
      });
    if (v.addressId && !v.customerId)
      ctx.addIssue({
        code: 'custom',
        path: ['addressId'],
        message: 'A saved address needs a saved customer',
      });
  });
export type CreateOrderBody = z.input<typeof CreateOrderBody>;

/** Partial update. What may change depends on the order's status (see docs/orders.md). */
export const UpdateOrderBody = z
  .object({
    address: AddressFields.optional(),
    items: Items.optional(),
    ...Adjustments,
    ...SourceFields,
    /** The version you were looking at. If someone changed the order since, the update is refused instead of overwriting. */
    ifVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).filter((k) => k !== 'ifVersion').length > 0, 'Nothing to update');
export type UpdateOrderBody = z.infer<typeof UpdateOrderBody>;

const Reason = z.string().trim().min(3, 'Say why (at least 3 characters)').max(300);

export const ChangeStatusBody = z.object({
  status: OrderStatus,
  /** Required for cancelled, delivery_failed, return_requested and returned. Kept in the status history. */
  reason: Reason.optional(),
  /**
   * For `returned`: which lines came back, in what condition and how many (`quantity`, 1 to the line's quantity; default
   * the whole line). When the list is given, a line that is NOT listed did not come back and adds no stock. Leave the
   * list out (or empty) when the whole order came back resaleable.
   */
  returnedItems: z
    .array(
      z.object({
        itemId: Uuid,
        condition: z.enum(['RESALEABLE', 'DAMAGED']),
        quantity: z.number().int().min(1).optional(),
      }),
    )
    .max(100)
    .optional(),
  ifVersion: z.number().int().min(1).optional(),
});
export type ChangeStatusBody = z.infer<typeof ChangeStatusBody>;

export const OrderItem = z.object({
  id: Uuid,
  variantId: Uuid,
  sku: z.string(),
  productName: z.string(),
  variantName: z.string(),
  quantity: z.number().int(),
  unitPriceMinor: z.number().int(),
  discountMinor: z.number().int(),
  lineTotalMinor: z.number().int(),
});
export type OrderItem = z.infer<typeof OrderItem>;

export const Shipping = z.object({
  recipientName: z.string(),
  phone: z.string(),
  line1: z.string(),
  area: z.string(),
  district: z.string(),
  division: z.string(),
  postalCode: z.string().nullable(),
});
export type Shipping = z.infer<typeof Shipping>;

export const OrderHistoryEntry = z.object({
  id: Uuid,
  fromStatus: OrderStatus.nullable(),
  toStatus: OrderStatus,
  reason: z.string().nullable(),
  actorUserId: Uuid.nullable(),
  actorName: z.string().nullable(),
  createdAt: z.string(),
});
export type OrderHistoryEntry = z.infer<typeof OrderHistoryEntry>;

export const Order = z.object({
  id: Uuid,
  orderNumber: z.number().int(),
  status: OrderStatus,
  source: OrderSource,
  sourceReference: z.string().nullable(),
  notes: z.string().nullable(),
  customer: z.object({ id: Uuid, name: z.string(), phone: z.string() }),
  shipping: Shipping,
  items: z.array(OrderItem),
  subtotalMinor: z.number().int(),
  discountMinor: z.number().int(),
  deliveryChargeMinor: z.number().int(),
  totalMinor: z.number().int(),
  advancePaidMinor: z.number().int(),
  /** What the courier collects. Worked out by the server. */
  codAmountMinor: z.number().int(),
  /**
   * True when the cash to collect has paisa. Real couriers (and the simulated one) take whole taka only, and a confirmed
   * order cannot be edited, so booking would be refused: warn before the person gets that far. Always sent by the API.
   */
  codHasPaisa: z.boolean().optional(),
  /** Whether stock is currently reserved for this order. */
  stockHeld: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Order = z.infer<typeof Order>;

export const OrderDetail = Order.extend({
  /** Every status the order has been in, oldest first. Append-only. */
  history: z.array(OrderHistoryEntry),
  /** What the person may do next, from the state machine. */
  allowedStatuses: z.array(OrderStatus),
});
export type OrderDetail = z.infer<typeof OrderDetail>;

/** What the order's cash looks like, in words a seller uses. Delivery alone never makes it collected. */
export const PAYMENT_STATE_VALUES = [
  /** Nothing to collect on delivery (paid in advance). */
  'prepaid',
  /** COD, the order has not been delivered yet. */
  'cod_pending',
  /** Delivered, and no courier statement has reported the cash. */
  'cod_unpaid',
  /** Delivered, and a statement reports part of the cash. */
  'cod_partial',
  /** A courier statement reports the full COD. */
  'cod_collected',
  /** Delivered without a real courier shipment: no statement can confirm the cash. */
  'cod_untracked',
  /** Cancelled or returned: nothing due. */
  'not_due',
] as const;
export const PaymentState = z.enum(PAYMENT_STATE_VALUES);
export type PaymentState = z.infer<typeof PaymentState>;

export const OrderCourier = z.object({
  provider: CourierProvider,
  simulated: z.boolean(),
  status: ShipmentStatus,
});
export type OrderCourier = z.infer<typeof OrderCourier>;

export const OrderSummary = z.object({
  id: Uuid,
  orderNumber: z.number().int(),
  status: OrderStatus,
  source: OrderSource,
  customerId: Uuid,
  customerName: z.string(),
  phone: z.string(),
  district: z.string(),
  itemCount: z.number().int(),
  totalMinor: z.number().int(),
  codAmountMinor: z.number().int(),
  createdAt: z.string(),
  /** The first item and how many more, ready to show in a table cell: "Matte Lipstick Set ×2 +1". */
  itemsSummary: z.string(),
  /** Cash status in a seller's words (see PaymentState). */
  payment: PaymentState,
  /** The order's latest real or simulated courier shipment, if any. */
  courier: OrderCourier.nullable(),
});
export type OrderSummary = z.infer<typeof OrderSummary>;

export const ORDER_SORTS = ['createdAt', 'orderNumber', 'totalMinor', 'status'] as const;

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

/** Filters shared by the order list and the order export. */
export const OrderFilters = z.object({
  /** Order number, customer name or phone, SKU, or product name. */
  q: z.string().trim().min(1).max(100).optional(),
  /** One or more statuses, comma separated: `confirmed,ready_to_ship`. */
  status: CommaList(OrderStatus).optional(),
  source: CommaList(OrderSource).optional(),
  customerId: Uuid.optional(),
  /** Created on or after / before, as dates (YYYY-MM-DD, Asia/Dhaka days). */
  from: Day.optional(),
  to: Day.optional(),
  minTotalMinor: z.coerce.number().int().min(0).optional(),
  maxTotalMinor: z.coerce.number().int().min(0).optional(),
});
export type OrderFilters = z.infer<typeof OrderFilters>;

export const OrderQuery = OrderFilters.extend({
  sort: z.enum(ORDER_SORTS).default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type OrderQuery = z.infer<typeof OrderQuery>;

export const OrderPage = z.object({
  items: z.array(OrderSummary),
  nextCursor: z.string().nullable(),
  /** How many orders match the filters in all (not just this page). */
  total: z.number().int(),
  /** How many orders are in each status for the same filters, ignoring the status filter itself (for the status chips). */
  statusCounts: z.record(z.string(), z.number().int()),
});
export type OrderPage = z.infer<typeof OrderPage>;

export const CustomerOrdersQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ---- duplicates, bulk actions -----------------------------------------------------------------------------------------

export const DuplicateCheckBody = z.object({
  phone: BdPhone,
  variantIds: z.array(Uuid).max(100).default([]),
  /** When editing an order, leave it out of the comparison. */
  excludeOrderId: Uuid.optional(),
});
export type DuplicateCheckBody = z.infer<typeof DuplicateCheckBody>;

/** A recent order that looks like this one. A hint for a person to look at, never a block and never a verdict on the customer. */
export const PotentialDuplicate = z.object({
  orderId: Uuid,
  orderNumber: z.number().int(),
  status: OrderStatus,
  createdAt: z.string(),
  totalMinor: z.number().int(),
  reasons: z.array(z.string()),
});
export type PotentialDuplicate = z.infer<typeof PotentialDuplicate>;

export const BulkStatusBody = z.object({
  orderIds: z
    .array(Uuid)
    .min(1, 'Choose at least one order')
    .max(100, 'At most 100 orders at a time'),
  status: OrderStatus,
  reason: Reason.optional(),
});
export type BulkStatusBody = z.infer<typeof BulkStatusBody>;

export const BulkResult = z.object({
  results: z.array(
    z.object({
      orderId: Uuid,
      orderNumber: z.number().int().nullable(),
      ok: z.boolean(),
      /** The status the order is in afterwards (unchanged if it was already there). */
      status: OrderStatus.nullable(),
      error: z.object({ code: z.string(), message: z.string() }).nullable(),
    }),
  ),
  succeeded: z.number().int(),
  failed: z.number().int(),
});
export type BulkResult = z.infer<typeof BulkResult>;

// ---- CSV import -------------------------------------------------------------------------------------------------------

export const OrderImportBody = z.object({
  /**
   * One row per order line; rows sharing an `order_ref` form one order. Columns: order_ref, customer_name, phone,
   * address_line, area, district, division, sku, quantity (required); postal_code, unit_price, line_discount, discount,
   * delivery_charge, advance_paid, source, source_reference, notes.
   */
  csv: z.string().min(1).max(2_000_000),
});
export type OrderImportBody = z.infer<typeof OrderImportBody>;

export const OrderImportPreview = z.object({
  fatal: z.string().nullable(),
  totalRows: z.number().int(),
  orderCount: z.number().int(),
  /** Orders that would be created. */
  validOrders: z.number().int(),
  /** Orders from this exact file that were already imported before (re-uploading is harmless). */
  alreadyImported: z.number().int(),
  errorCount: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
  /** Total of the orders that would be created, in paisa, as the server works it out. */
  totalMinor: z.number().int(),
});
export type OrderImportPreview = z.infer<typeof OrderImportPreview>;

export const OrderImportResult = z.object({
  created: z.number().int(),
  alreadyImported: z.number().int(),
  failed: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
  orderNumbers: z.array(z.number().int()),
});
export type OrderImportResult = z.infer<typeof OrderImportResult>;
