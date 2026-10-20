import { z } from 'zod';
import { Uuid } from './auth.js';
import { IdempotencyKey } from './catalog.js';

// ---- vocabulary -------------------------------------------------------------------------------------------------------

/** Mirrors COURIER_PROVIDERS in @orderloop/courier-sdk (the API checks they agree); contracts depends on nothing. */
export const COURIER_PROVIDER_VALUES = ['mock', 'pathao', 'steadfast'] as const;
export const CourierProvider = z.enum(COURIER_PROVIDER_VALUES);
export type CourierProvider = z.infer<typeof CourierProvider>;

export const COURIER_ENVIRONMENT_VALUES = ['simulated', 'sandbox', 'production'] as const;
export const CourierEnvironment = z.enum(COURIER_ENVIRONMENT_VALUES);
export type CourierEnvironment = z.infer<typeof CourierEnvironment>;

/** Where a parcel is, in our words. The courier's own wording is always kept next to it. */
export const SHIPMENT_STATUS_VALUES = [
  'booking',
  'booking_failed',
  'booking_uncertain',
  'booked',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'partial_delivered',
  'delivery_failed',
  'on_hold',
  'returning',
  'returned',
  'cancelled',
  'unknown',
] as const;
export const ShipmentStatus = z.enum(SHIPMENT_STATUS_VALUES);
export type ShipmentStatus = z.infer<typeof ShipmentStatus>;

export const MOCK_OUTCOME_VALUES = [
  'success',
  'validation_error',
  'rate_limited',
  'unavailable',
  'timeout_before_booking',
  'timeout_after_booking',
  'rate_limited_once',
  'unavailable_once',
  'timeout_before_booking_once',
  'timeout_after_booking_once',
] as const;

/** The mock's simulated events (what a real courier would report as the parcel moves). */
export const SIMULATED_EVENTS = [
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'delivery_failed',
  'on_hold',
  'returning',
  'returned',
] as const;
export const SimulatedEvent = z.enum(SIMULATED_EVENTS);
export type SimulatedEvent = z.infer<typeof SimulatedEvent>;

// ---- connections ------------------------------------------------------------------------------------------------------

export const CourierCapabilities = z.object({
  quote: z.boolean(),
  tracking: z.boolean(),
  webhooks: z.boolean(),
  cancel: z.boolean(),
  returns: z.boolean(),
  locations: z.boolean(),
  /** `reference`: a booking that timed out can be looked up. `none`: it cannot, so a person must settle it. */
  duplicateProtection: z.enum(['reference', 'none']),
  /** Parcel weights the courier accepts, in kg. Booking outside it is refused with 400 before anything is created. */
  weightKg: z.object({ min: z.number(), max: z.number() }),
});
export type CourierCapabilities = z.infer<typeof CourierCapabilities>;

/** Non-secret choices. Which ones matter depends on the courier. */
export const CourierSettings = z.object({
  /** Pathao: the store the parcels are picked up from. */
  storeId: z.number().int().positive().optional(),
  /** Pathao: 48 = normal, 12 = on demand. */
  deliveryType: z.union([z.literal(48), z.literal(12)]).optional(),
  /** Pathao: 2 = parcel, 1 = document. */
  itemType: z.union([z.literal(1), z.literal(2)]).optional(),
  /** Pathao takes 0.5 to 10 kg. */
  defaultWeightKg: z.number().min(0.5).max(10).optional(),
  /** Steadfast: which of its two addresses to use. */
  host: z.enum(['steadfast', 'packzy']).optional(),
  /** Simulated courier only: how it should behave, to rehearse failures. */
  outcome: z.enum(MOCK_OUTCOME_VALUES).optional(),
  referenceLookup: z.boolean().optional(),
});
export type CourierSettings = z.infer<typeof CourierSettings>;

export const CourierConnection = z.object({
  id: Uuid,
  environment: CourierEnvironment,
  /** True when the credentials are saved. They are never sent back. */
  hasCredentials: z.boolean(),
  hasWebhookSecret: z.boolean(),
  settings: CourierSettings,
  enabled: z.boolean(),
  /** Where the courier should send status updates. Shown so it can be pasted into the courier's panel. */
  webhookUrl: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  lastCheckOk: z.boolean().nullable(),
  lastCheckMessage: z.string().nullable(),
  updatedAt: z.string(),
});
export type CourierConnection = z.infer<typeof CourierConnection>;

export const CourierEntry = z.object({
  provider: CourierProvider,
  name: z.string(),
  /** Nothing this courier does is real. */
  simulated: z.boolean(),
  capabilities: CourierCapabilities,
  /** Environments this courier offers (Steadfast documents only its live service). */
  environments: z.array(CourierEnvironment),
  /** The credential fields the seller fills in, by name, so the form can be drawn without knowing each courier. */
  credentialFields: z.array(
    z.object({ key: z.string(), label: z.string(), optional: z.boolean() }),
  ),
  /** False when the server cannot keep secrets safely (no encryption key) or the courier is switched off here. */
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  connection: CourierConnection.nullable(),
});
export type CourierEntry = z.infer<typeof CourierEntry>;

export const CourierProviderParam = z.object({ provider: CourierProvider });

const secret = z.string().trim().min(1).max(500);
export const SaveCourierBody = z.object({
  environment: CourierEnvironment.optional(),
  /** Write-only. Send only what changed; fields left out keep their saved value. */
  credentials: z
    .object({
      clientId: secret.optional(),
      clientSecret: secret.optional(),
      username: secret.optional(),
      password: secret.optional(),
      apiKey: secret.optional(),
      secretKey: secret.optional(),
    })
    .strict()
    .optional(),
  /** Write-only: the secret or token the courier sends back with each webhook. */
  webhookSecret: z.string().trim().min(16, 'Use at least 16 characters').max(200).optional(),
  settings: CourierSettings.optional(),
  enabled: z.boolean().optional(),
});
export type SaveCourierBody = z.infer<typeof SaveCourierBody>;

export const CourierCheck = z.object({
  ok: z.boolean(),
  details: z.array(z.string()),
  message: z.string().nullable(),
  checkedAt: z.string(),
});
export type CourierCheck = z.infer<typeof CourierCheck>;

export const LocationQuery = z.object({
  kind: z.enum(['cities', 'zones', 'areas']),
  parentId: z.coerce.number().int().positive().optional(),
});
export const LocationItem = z.object({
  id: z.number(),
  name: z.string(),
  homeDelivery: z.boolean().optional(),
  pickup: z.boolean().optional(),
});
export type LocationItem = z.infer<typeof LocationItem>;

// ---- quotes and shipments ---------------------------------------------------------------------------------------------

const Place = {
  cityId: z.number().int().positive().optional(),
  zoneId: z.number().int().positive().optional(),
  areaId: z.number().int().positive().optional(),
};

export const QuoteBody = z.object({
  provider: CourierProvider,
  weightKg: z.number().min(0.1).max(50).optional(),
  ...Place,
});
export const ShippingQuote = z.object({
  provider: CourierProvider,
  simulated: z.boolean(),
  /** Null when the courier cannot say. */
  serviceable: z.boolean().nullable(),
  feeMinor: z.number().int().nullable(),
  codEnabled: z.boolean().nullable(),
  codFeeMinor: z.number().int().nullable(),
  message: z.string().nullable(),
});
export type ShippingQuote = z.infer<typeof ShippingQuote>;

export const BookShipmentBody = z.object({
  provider: CourierProvider,
  /** Send the same key when retrying: the retry returns the booking already made instead of making another. */
  idempotencyKey: IdempotencyKey,
  weightKg: z.number().min(0.1).max(50).optional(),
  note: z.string().trim().max(400).optional(),
  ...Place,
});
export type BookShipmentBody = z.infer<typeof BookShipmentBody>;

export const ShipmentEvent = z.object({
  id: Uuid,
  source: z.enum(['booking', 'webhook', 'poll', 'manual', 'simulation']),
  /** The courier's own words for this update, exactly as received. */
  providerStatus: z.string().nullable(),
  /** Our status after it, or null when it changed nothing. */
  mappedStatus: ShipmentStatus.nullable(),
  /** False for a repeat, an out-of-order update or something we do not understand (recorded, never acted on). */
  applied: z.boolean(),
  note: z.string().nullable(),
  occurredAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ShipmentEvent = z.infer<typeof ShipmentEvent>;

export const ShipmentActions = z.object({
  canRefresh: z.boolean(),
  canCancel: z.boolean(),
  /** A booking we could not confirm: a person looks at the courier's panel and says what happened. */
  needsResolution: z.boolean(),
  canSimulate: z.boolean(),
  /** Booked at a courier that offers no cancel: it can only be marked cancelled after calling them. */
  canMarkCancelled: z.boolean(),
});

export const Shipment = z.object({
  id: Uuid,
  orderId: Uuid,
  orderNumber: z.number().int(),
  provider: CourierProvider,
  environment: CourierEnvironment,
  /** True when nothing here is real: no courier knows about this parcel. */
  simulated: z.boolean(),
  status: ShipmentStatus,
  providerStatus: z.string().nullable(),
  consignmentId: z.string().nullable(),
  reference: z.string(),
  trackingCode: z.string().nullable(),
  trackingUrl: z.string().nullable(),
  attempt: z.number().int(),
  codAmountMinor: z.number().int(),
  deliveryFeeMinor: z.number().int().nullable(),
  failureReason: z.string().nullable(),
  bookedAt: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
  actions: ShipmentActions,
});
export type Shipment = z.infer<typeof Shipment>;

export const ShipmentDetail = Shipment.extend({ events: z.array(ShipmentEvent) });
export type ShipmentDetail = z.infer<typeof ShipmentDetail>;

export const CancelShipmentBody = z.object({
  reason: z.string().trim().min(3, 'Say why').max(200),
});

export const RESOLUTIONS = ['not_booked', 'booked', 'cancelled_at_courier'] as const;
export const ResolveShipmentBody = z
  .object({
    resolution: z.enum(RESOLUTIONS),
    /** The courier's consignment id, when you can see it in its panel. */
    consignmentId: z.string().trim().min(1).max(100).optional(),
    reason: z.string().trim().min(3, 'Say what you saw').max(300),
  })
  .refine((v) => v.resolution === 'booked' || !v.consignmentId, {
    message: 'A consignment id only goes with “booked”',
    path: ['consignmentId'],
  });
export type ResolveShipmentBody = z.infer<typeof ResolveShipmentBody>;

export const SimulateBody = z.object({ event: SimulatedEvent });

// ---- webhooks ---------------------------------------------------------------------------------------------------------

export const WebhookParams = z.object({
  provider: CourierProvider,
  tenantId: Uuid,
  connectionId: Uuid,
});
export const WebhookAck = z.object({ status: z.string() });
