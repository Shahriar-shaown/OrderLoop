import { z } from 'zod';
import { Uuid } from './auth.js';

/**
 * TikTok Shop channel (docs/tiktok-shop.md). READ-ONLY mirror of a TikTok shop's orders, used to keep OrderLoop's stock honest.
 *
 * Deliberately separate from OrderLoop's own orders: OrderLoop's orders, money, phone numbers and addresses are
 * Bangladesh/BDT-only, while a TikTok order arrives in the SHOP'S OWN currency with its own country's address. So:
 *  - every amount here is an integer in the minor units of `currency` (`currencyExponent` decimal places), exactly as TikTok
 *    reported it. It is never converted to BDT and never added to a BDT figure (revenue, profit, COD, dashboards);
 *  - no buyer personal data exists anywhere in these shapes: no name, phone, email or address.
 * The live connection has never been run against TikTok (no credentials exist): see the status block in docs/tiktok-shop.md.
 */

// ---- vocabulary -------------------------------------------------------------------------------------------------------

/** `mock`: a clearly labelled simulated shop (no TikTok account). `live`: the real TikTok Shop API, never tested with credentials. */
export const TikTokMode = z.enum(['mock', 'live']);
export type TikTokMode = z.infer<typeof TikTokMode>;

/** `needs_reconnect`: TikTok no longer accepts the saved access. `permission_error`: a permission was removed or is missing. */
export const TIKTOK_CONNECTION_STATUSES = [
  'active',
  'needs_reconnect',
  'permission_error',
  'disconnected',
] as const;
export const TikTokConnectionStatus = z.enum(TIKTOK_CONNECTION_STATUSES);
export type TikTokConnectionStatus = z.infer<typeof TikTokConnectionStatus>;

/**
 * What the stock did for an order.
 *  none           nothing reserved (not paid yet, on hold, cancelled before it was ever reserved, or unknown status)
 *  reserved       stock is held for the order
 *  shipped        stock left (the reservation was fulfilled)
 *  released       the order was cancelled before shipping and the held stock was given back
 *  needs_mapping  at least one line's TikTok SKU is not linked to an OrderLoop variant: NOTHING moved for the whole order yet
 *  stock_short    not enough available stock for the whole order: nothing was reserved (never oversold, never half-reserved)
 */
export const TIKTOK_STOCK_STATES = [
  'none',
  'reserved',
  'shipped',
  'released',
  'needs_mapping',
  'stock_short',
] as const;
export const TikTokStockState = z.enum(TIKTOK_STOCK_STATES);
export type TikTokStockState = z.infer<typeof TikTokStockState>;

/** The statuses TikTok documents. The API sends the raw status as a string (a new one may appear), so a client must tolerate others. */
export const TIKTOK_ORDER_STATUSES = [
  'UNPAID',
  'ON_HOLD',
  'AWAITING_SHIPMENT',
  'PARTIALLY_SHIPPING',
  'AWAITING_COLLECTION',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
] as const;

/** Set when the order needs a person: stock had already shipped when TikTok cancelled it (returns are out of scope). */
export const TikTokAttention = z.enum(['cancelled_after_shipping']);
export type TikTokAttention = z.infer<typeof TikTokAttention>;

export const TikTokHoldState = z.enum(['held', 'shipped', 'released']);
export type TikTokHoldState = z.infer<typeof TikTokHoldState>;

// ---- connections ------------------------------------------------------------------------------------------------------

export const TikTokConnection = z.object({
  id: Uuid,
  /** TikTok's shop id (a mock shop's starts with `mock_`). */
  shopId: z.string(),
  shopName: z.string(),
  /** Two-letter region of the shop, e.g. `MY`. */
  region: z.string().nullable(),
  sellerType: z.string().nullable(),
  /** The shop's currency (known once an order has been seen, or for a mock shop). */
  currency: z.string().nullable(),
  status: TikTokConnectionStatus,
  /** True for the simulated shop: label it. */
  mock: z.boolean(),
  scopes: z.array(z.string()),
  /** When the access token needs renewing (the worker renews it by itself); null for a mock shop or after disconnecting. */
  tokenExpiresAt: z.string().nullable(),
  /** The last time the catch-up check of orders finished. */
  lastSyncedAt: z.string().nullable(),
  /** A short code (e.g. `token_invalid`, `permission_denied`) and a sentence with no tokens in it. */
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  connectedAt: z.string(),
  disconnectedAt: z.string().nullable(),
});
export type TikTokConnection = z.infer<typeof TikTokConnection>;

export const TikTokOverview = z.object({
  mode: TikTokMode,
  /** Live mode only: whether this server has everything the real TikTok Shop API needs (it cannot be used otherwise). */
  liveConfigured: z.boolean(),
  /** The webhook address to give TikTok (live), else null. */
  webhookUrl: z.string().nullable(),
  /** The address TikTok sends the person back to after authorising (live), else null: it must be registered with the app. */
  redirectUrl: z.string().nullable(),
  connections: z.array(TikTokConnection),
  /** Orders waiting for a SKU link (`needs_mapping`) and orders short of stock (`stock_short`): badges for the screen. */
  needsMappingOrders: z.number().int(),
  stockShortOrders: z.number().int(),
  /** Orders cancelled after their stock shipped (`attention`). */
  attentionOrders: z.number().int(),
  /** TikTok SKUs not yet linked to a variant. */
  unmappedSkus: z.number().int(),
});
export type TikTokOverview = z.infer<typeof TikTokOverview>;

// ---- sign-in (live) ---------------------------------------------------------------------------------------------------

export const TikTokOauthStartBody = z.object({}).strict();
/**
 * `authorizeUrl` is a one-time link (60 seconds, single use) to the API's `GET /v1/integrations/tiktok-shop/oauth/begin`, to be
 * opened as a top-level navigation: the API binds the sign-in to that browser with a cookie and then redirects to TikTok.
 */
export const TikTokOauthStartResult = z.object({ mode: TikTokMode, authorizeUrl: z.string() });
export type TikTokOauthStartResult = z.infer<typeof TikTokOauthStartResult>;

export const TikTokOauthBeginQuery = z.object({ ticket: z.string().max(200).optional() });
export const TikTokOauthCallbackQuery = z.object({
  code: z.string().max(2000).optional(),
  app_key: z.string().max(200).optional(),
  state: z.string().max(2000).optional(),
  locale: z.string().max(50).optional(),
  shop_region: z.string().max(20).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

/** Where the sign-in sends the person back with `?error=<code>`: the codes are a short, fixed set. */
export const TIKTOK_OAUTH_ERRORS = [
  'access_denied',
  'invalid_state',
  'tiktok_not_configured',
  'tiktok_permission_denied',
  'tiktok_token_invalid',
  'tiktok_unavailable',
  'rate_limited',
] as const;

export const TikTokOauthShop = z.object({
  id: z.string(),
  name: z.string(),
  region: z.string().nullable(),
  sellerType: z.string().nullable(),
  /** Already connected to a business (this one or another): cannot be selected. */
  alreadyConnected: z.boolean(),
});
export const TikTokOauthSession = z.object({
  mode: TikTokMode,
  id: Uuid,
  expiresAt: z.string(),
  shops: z.array(TikTokOauthShop),
  reconnectConnectionId: Uuid.nullable(),
});
export type TikTokOauthSession = z.infer<typeof TikTokOauthSession>;

export const ConnectTikTokShopsBody = z.object({
  sessionId: Uuid,
  shopIds: z.array(z.string().min(1).max(64)).min(1).max(25),
});
export type ConnectTikTokShopsBody = z.infer<typeof ConnectTikTokShopsBody>;
export const ConnectTikTokFailure = z.object({
  shopId: z.string(),
  code: z.string(),
  message: z.string(),
});
export const ConnectTikTokShopsResult = z.object({
  mode: TikTokMode,
  connections: z.array(TikTokConnection),
  /** Shops that could not be connected, each with an error code from the API's error table. When none could, the call fails instead. */
  failures: z.array(ConnectTikTokFailure),
});
export type ConnectTikTokShopsResult = z.infer<typeof ConnectTikTokShopsResult>;

export const TikTokSyncResult = z.object({
  mode: TikTokMode,
  /** Orders read from TikTok in this run (0 for a mock shop: there is no remote to read). */
  fetched: z.number().int(),
  /** Orders created or changed in the mirror. */
  updated: z.number().int(),
  /** Waiting orders (needs_mapping / stock_short) that were looked at again. */
  reconciled: z.number().int(),
  /** More orders remain than one run reads: run it again. */
  truncated: z.boolean(),
});
export type TikTokSyncResult = z.infer<typeof TikTokSyncResult>;

// ---- mock mode -------------------------------------------------------------------------------------------------------------

export const TikTokMockConnectionBody = z
  .object({
    shopName: z.string().trim().min(1).max(100).optional(),
    region: z
      .string()
      .regex(/^[A-Z]{2}$/, 'Two capital letters, e.g. MY')
      .default('MY'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Three capital letters, e.g. MYR')
      .default('MYR'),
  })
  .strict();
export type TikTokMockConnectionBody = z.infer<typeof TikTokMockConnectionBody>;

export const TikTokMockItem = z
  .object({
    /** TikTok's SKU id. The same id on a later order is the same SKU (and the same link). */
    skuId: z.string().trim().min(1).max(64),
    /** The seller's own SKU code: what auto-linking matches against an OrderLoop variant's SKU. */
    sellerSku: z.string().trim().min(1).max(100).optional(),
    productName: z.string().trim().min(1).max(200).optional(),
    quantity: z.number().int().min(1).max(10_000).default(1),
    /** In minor units of the order's currency. */
    unitPriceMinor: z.number().int().min(0).max(2_000_000_000).default(0),
  })
  .strict();

export const TikTokMockOrderBody = z
  .object({
    connectionId: Uuid,
    /** Repeat an id to send the same order again: it must create nothing new. Defaults to a fresh id. */
    externalOrderId: z.string().trim().min(1).max(64).optional(),
    status: z.string().trim().min(1).max(40).default('AWAITING_SHIPMENT'),
    onHold: z.boolean().default(false),
    items: z.array(TikTokMockItem).min(1).max(50),
    /** Repeat a notification id to replay the same webhook delivery. Defaults to a fresh one. */
    notificationId: z.string().trim().min(1).max(100).optional(),
    /** TikTok's `update_time` for the order; defaults to now. */
    updateTime: z.string().datetime().optional(),
  })
  .strict();
export type TikTokMockOrderBody = z.infer<typeof TikTokMockOrderBody>;

export const TikTokMockStatusBody = z
  .object({
    status: z.string().trim().min(1).max(40),
    onHold: z.boolean().optional(),
    notificationId: z.string().trim().min(1).max(100).optional(),
    /** TikTok's `update_time` for the change; defaults to now. An older time than the stored one changes nothing (late delivery). */
    updateTime: z.string().datetime().optional(),
  })
  .strict();
export type TikTokMockStatusBody = z.infer<typeof TikTokMockStatusBody>;

export const TikTokMockResult = z.object({
  mode: TikTokMode,
  mock: z.literal(true),
  eventId: Uuid,
  notificationId: z.string(),
  /** This notification id arrived before: nothing new was stored. */
  duplicate: z.boolean(),
  status: z.enum(['received', 'processed', 'ignored', 'failed']),
  /** The mirrored order (null when the event did not produce one). */
  orderId: Uuid.nullable(),
  stockState: TikTokStockState.nullable(),
});
export type TikTokMockResult = z.infer<typeof TikTokMockResult>;

// ---- mirrored orders -------------------------------------------------------------------------------------------------------

export const TikTokVariantRef = z.object({
  id: Uuid,
  sku: z.string(),
  productName: z.string(),
  variantName: z.string(),
});
export type TikTokVariantRef = z.infer<typeof TikTokVariantRef>;

export const TikTokOrderLine = z.object({
  /** `sku:<TikTok sku id>`: one stock effect per key. */
  key: z.string(),
  externalSkuId: z.string(),
  sellerSku: z.string().nullable(),
  productName: z.string().nullable(),
  /** Units (TikTok lists one line item per unit; they are added up per SKU). */
  quantity: z.number().int(),
  /** In minor units of the order's currency. */
  unitPriceMinor: z.number().int(),
  /** The link this line goes through (null = not mapped: the order waits). */
  variant: TikTokVariantRef.nullable(),
  mapped: z.boolean(),
  /** What the stock did for this line (null = nothing yet). */
  hold: TikTokHoldState.nullable(),
  /** The id of the SKU link, for `PUT /v1/tiktok-sku-links/:id`. */
  skuLinkId: Uuid.nullable(),
});
export type TikTokOrderLine = z.infer<typeof TikTokOrderLine>;

export const TikTokOrderSummary = z.object({
  id: Uuid,
  connectionId: Uuid,
  shopName: z.string(),
  region: z.string().nullable(),
  externalOrderId: z.string(),
  /** TikTok's own status text (see TIKTOK_ORDER_STATUSES; others may appear). */
  status: z.string(),
  /** Inside the buyer's cancellation window: stock does not move yet. */
  onHold: z.boolean(),
  statusUpdatedAt: z.string().nullable(),
  createdAtTiktok: z.string().nullable(),
  /** The shop's currency. Amounts are NOT BDT: show them with this currency only, never add them to BDT figures. */
  currency: z.string(),
  /** Decimal places of the currency's minor unit (amount / 10^currencyExponent is the major-unit value). */
  currencyExponent: z.number().int(),
  totalMinor: z.number().int(),
  /** Units in the order. */
  unitCount: z.number().int(),
  stockState: TikTokStockState,
  attention: TikTokAttention.nullable(),
  /** Lines with no linked variant. */
  unmappedLineCount: z.number().int(),
  mock: z.boolean(),
});
export type TikTokOrderSummary = z.infer<typeof TikTokOrderSummary>;

export const TikTokOrder = TikTokOrderSummary.extend({
  mode: TikTokMode,
  subtotalMinor: z.number().int(),
  sellerDiscountMinor: z.number().int(),
  platformDiscountMinor: z.number().int(),
  shippingMinor: z.number().int(),
  taxMinor: z.number().int(),
  fulfilmentType: z.string().nullable(),
  lines: z.array(TikTokOrderLine),
});
export type TikTokOrder = z.infer<typeof TikTokOrder>;

export const TikTokOrderQuery = z.object({
  status: z.string().trim().min(1).max(40).optional(),
  stockState: TikTokStockState.optional(),
  connectionId: Uuid.optional(),
  /** Only orders flagged for a person (cancelled after shipping). */
  attention: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type TikTokOrderQuery = z.infer<typeof TikTokOrderQuery>;
export const TikTokOrderPage = z.object({
  mode: TikTokMode,
  items: z.array(TikTokOrderSummary),
  nextCursor: z.string().nullable(),
  /** Orders per stock state (all shops, no filter): for tabs and badges. */
  counts: z.record(z.string(), z.number().int()),
});
export type TikTokOrderPage = z.infer<typeof TikTokOrderPage>;

// ---- SKU links ---------------------------------------------------------------------------------------------------------------

export const TikTokSkuLink = z.object({
  id: Uuid,
  connectionId: Uuid,
  shopName: z.string(),
  externalSkuId: z.string(),
  sellerSku: z.string().nullable(),
  productName: z.string().nullable(),
  /** Null = not mapped: orders with this SKU wait (`needs_mapping`). */
  variant: TikTokVariantRef.nullable(),
  /** `auto`: matched by the seller SKU equalling an OrderLoop variant SKU. `manual`: a person chose (or cleared) it. */
  source: z.enum(['auto', 'manual']),
  /** Orders waiting for a link that include this SKU. */
  waitingOrders: z.number().int(),
  updatedAt: z.string(),
});
export type TikTokSkuLink = z.infer<typeof TikTokSkuLink>;

export const TikTokSkuLinkQuery = z.object({
  unmapped: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  connectionId: Uuid.optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TikTokSkuLinkQuery = z.infer<typeof TikTokSkuLinkQuery>;
export const TikTokSkuLinkPage = z.object({
  items: z.array(TikTokSkuLink),
  nextCursor: z.string().nullable(),
  unmappedCount: z.number().int(),
});
export type TikTokSkuLinkPage = z.infer<typeof TikTokSkuLinkPage>;

/** Map a TikTok SKU to a variant, or `null` to clear the link. Waiting orders are looked at again straight away. */
export const UpdateTikTokSkuLinkBody = z.object({ variantId: Uuid.nullable() }).strict();
export type UpdateTikTokSkuLinkBody = z.infer<typeof UpdateTikTokSkuLinkBody>;
export const UpdateTikTokSkuLinkResult = z.object({
  link: TikTokSkuLink,
  /** Waiting orders that were looked at again because of this change. */
  reconciledOrders: z.number().int(),
});
export type UpdateTikTokSkuLinkResult = z.infer<typeof UpdateTikTokSkuLinkResult>;
