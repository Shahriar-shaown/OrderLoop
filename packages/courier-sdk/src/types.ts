/**
 * The provider-independent courier model. Everything outside this package talks to a courier through `CourierAdapter` and
 * these types, never to Pathao or Steadfast directly, so a provider can be added, swapped or simulated without touching
 * orders or the API.
 */

export const COURIER_PROVIDERS = ['mock', 'pathao', 'steadfast'] as const;
export type CourierProvider = (typeof COURIER_PROVIDERS)[number];

/**
 * Where a parcel is, in our words. Every provider status is mapped onto one of these, and the provider's own status text is
 * always kept next to it (never replaced).
 *
 * `unknown` means the provider sent a status we cannot place. It never moves a shipment or an order: it is recorded and
 * shown, and a person decides.
 */
export const SHIPMENT_STATUSES = [
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
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export interface Capabilities {
  /** Delivery fee and serviceability before booking. */
  quote: boolean;
  /** Ask the provider where a parcel is (poll). */
  tracking: boolean;
  /** The provider pushes status changes to a URL we give it. */
  webhooks: boolean;
  /** The provider has a documented way to cancel a booking. */
  cancel: boolean;
  /** The provider reports failed deliveries and returns (as statuses). */
  returns: boolean;
  /** City / zone / area lists for addresses. */
  locations: boolean;
  /**
   * Can a booking that timed out be looked up by our reference to see whether it exists?
   *  - `reference`: yes (a retry is then safe once looked up)
   *  - `none`: no. After an unknown outcome the booking must be settled by a person, never retried blindly.
   */
  duplicateProtection: 'reference' | 'none';
}

export interface Recipient {
  name: string;
  /** Canonical +8801XXXXXXXXX. Adapters convert to what the provider wants. */
  phone: string;
  secondaryPhone?: string | undefined;
  address: string;
  postalCode?: string | undefined;
}

export interface BookingRequest {
  /**
   * Our own stable reference for this booking, the same on every retry (for example `OL-1001`). It is what the provider
   * stores as the merchant's order or invoice id.
   */
  reference: string;
  recipient: Recipient;
  /** Cash to collect, in paisa. Providers take whole taka: an amount with paisa is refused, never rounded. */
  codAmountMinor: number;
  itemDescription: string;
  itemQuantity: number;
  /** Kilograms. */
  weightKg?: number | undefined;
  note?: string | undefined;
  /** Provider-specific choices (Pathao: store, city/zone/area, delivery and item type). Validated by the adapter. */
  options?: Record<string, unknown> | undefined;
}

export interface BookingResult {
  /** The provider's id for the parcel. Null when the provider only identifies it by our reference. */
  consignmentId: string | null;
  trackingCode?: string | undefined;
  trackingUrl?: string | undefined;
  /** The provider's own status text, exactly as sent. */
  providerStatus: string;
  status: ShipmentStatus;
  /** The delivery fee the provider reported, in paisa, when it reports one. */
  deliveryFeeMinor?: number | undefined;
  /** The provider's reply with nothing secret in it. */
  raw: unknown;
}

export interface TrackingResult {
  consignmentId: string | null;
  providerStatus: string;
  status: ShipmentStatus;
  /** When the provider says the status last changed. */
  updatedAt?: string | undefined;
  message?: string | undefined;
  deliveryFeeMinor?: number | undefined;
  raw: unknown;
}

export interface QuoteRequest {
  recipient: Pick<Recipient, 'address'>;
  codAmountMinor: number;
  weightKg?: number | undefined;
  options?: Record<string, unknown> | undefined;
}

export interface QuoteResult {
  /** `null` when the provider cannot say. */
  serviceable: boolean | null;
  feeMinor?: number | undefined;
  /** What the provider charges for collecting cash, in paisa, when it says. */
  codFeeMinor?: number | undefined;
  codEnabled?: boolean | undefined;
  notes: string[];
  raw: unknown;
}

export interface LocationItem {
  id: number;
  name: string;
  homeDelivery?: boolean | undefined;
  pickup?: boolean | undefined;
}

export interface ConnectionCheck {
  ok: true;
  /** Plain facts to show the merchant: store names, an account label. Never credentials or tokens. */
  details: string[];
}

/** A parsed, authenticated webhook, in our terms. */
export interface CourierEvent {
  /** Dedupe key: identical for retries of the same event. */
  eventKey: string;
  consignmentId: string | null;
  reference: string | null;
  providerStatus: string;
  /** `null` for an event that carries a message but no status (a tracking note). */
  status: ShipmentStatus | null;
  message?: string | undefined;
  occurredAt?: string | undefined;
  deliveryFeeMinor?: number | undefined;
  codAmountMinor?: number | undefined;
  /** The provider's payload, kept whole as evidence. */
  raw: unknown;
}

export interface TrackTarget {
  consignmentId: string | null;
  reference: string;
  /** What we last knew. Only the simulated courier uses it (it has no server to ask). */
  last?: { providerStatus: string; status: ShipmentStatus } | undefined;
}

export interface CourierAdapter {
  readonly provider: CourierProvider;
  readonly capabilities: Capabilities;
  /** True for the mock: nothing it books is real. */
  readonly simulated: boolean;

  /** Prove the credentials work, without booking anything. */
  verifyConnection(): Promise<ConnectionCheck>;
  quote?(request: QuoteRequest): Promise<QuoteResult>;
  book(request: BookingRequest): Promise<BookingResult>;
  /** Look a booking up by our reference (providers that can). `null` means the provider has no such booking. */
  findByReference?(reference: string): Promise<TrackingResult | null>;
  track(target: TrackTarget): Promise<TrackingResult>;
  cancel?(target: TrackTarget): Promise<{ cancelled: boolean; message?: string }>;
  locations?: {
    cities(): Promise<LocationItem[]>;
    zones(cityId: number): Promise<LocationItem[]>;
    areas(zoneId: number): Promise<LocationItem[]>;
  };
}
