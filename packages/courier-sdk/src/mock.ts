import { createHash } from 'node:crypto';
import { CourierError } from './errors.js';
import { wholeTaka } from './money.js';
import type {
  BookingRequest,
  BookingResult,
  Capabilities,
  ConnectionCheck,
  CourierAdapter,
  LocationItem,
  QuoteRequest,
  QuoteResult,
  TrackTarget,
  TrackingResult,
} from './types.js';

/**
 * A courier that does not exist, for development, demos and tests. Everything it books is SIMULATED: the parcel ids say
 * `SIM-`, the tracking link is not a real page, and nothing leaves the building. It behaves like a real provider, including
 * the awkward parts, so the code around it can be exercised:
 *
 *   outcome: success | validation_error | rate_limited | unavailable | timeout_before_booking | timeout_after_booking
 *            (and the `_once` forms, which misbehave on the first attempt only)
 *   referenceLookup: whether a booking can be found again by our reference (like Steadfast) or not (like Pathao)
 *
 * It keeps a record of what it "booked" in memory, so a repeated booking with the same reference is detectable. Real
 * providers do not behave identically: Pathao would simply create a second parcel.
 */
export interface MockSettings {
  outcome?:
    | 'success'
    | 'validation_error'
    | 'rate_limited'
    | 'unavailable'
    | 'timeout_before_booking'
    | 'timeout_after_booking'
    | 'rate_limited_once'
    | 'unavailable_once'
    | 'timeout_before_booking_once'
    | 'timeout_after_booking_once'
    | undefined;
  referenceLookup?: boolean | undefined;
  /** Delivery fee in paisa. */
  feeMinor?: number | undefined;
  serviceable?: boolean | undefined;
}

export interface MockBooking {
  consignmentId: string;
  reference: string;
  count: number;
}

/** What the simulated courier "booked", by connection. Process memory only: a restart forgets it, like a real outage would not. */
export const MOCK_BOOKINGS = new Map<string, MockBooking[]>();
const ONCE = new Set<string>();

export class MockAdapter implements CourierAdapter {
  readonly provider = 'mock' as const;
  readonly simulated = true;
  readonly capabilities: Capabilities;

  constructor(
    private readonly scope: string,
    private readonly settings: MockSettings = {},
  ) {
    this.capabilities = {
      quote: true,
      tracking: true,
      webhooks: false,
      cancel: true,
      returns: true,
      locations: true,
      duplicateProtection: settings.referenceLookup ? 'reference' : 'none',
      weightKg: { min: 0.1, max: 50 },
    };
  }

  async verifyConnection(): Promise<ConnectionCheck> {
    return {
      ok: true,
      details: ['Simulated courier. Nothing it books is real, and no courier is contacted.'],
    };
  }

  async quote(request: QuoteRequest): Promise<QuoteResult> {
    const serviceable = this.settings.serviceable ?? true;
    return {
      serviceable,
      ...(serviceable
        ? {
            feeMinor: this.settings.feeMinor ?? 6000,
            codFeeMinor: Math.floor(request.codAmountMinor / 100),
            codEnabled: true,
          }
        : {}),
      notes: ['Simulated fee. A real courier will quote its own.'],
      raw: { simulated: true },
    };
  }

  locations = {
    cities: async (): Promise<LocationItem[]> => [{ id: 1, name: 'Dhaka (simulated)' }],
    zones: async (cityId: number): Promise<LocationItem[]> => [
      { id: cityId * 10 + 1, name: 'Dhanmondi (simulated)' },
    ],
    areas: async (zoneId: number): Promise<LocationItem[]> => [
      { id: zoneId * 10 + 1, name: 'Road 5 (simulated)', homeDelivery: true, pickup: true },
    ],
  };

  /** True the first time for a `_once` outcome, so it misbehaves once and then works. */
  private firstTime(reference: string, name: string): boolean {
    const key = `${this.scope}:${reference}:${name}`;
    if (ONCE.has(key)) return false;
    ONCE.add(key);
    return true;
  }

  async book(request: BookingRequest): Promise<BookingResult> {
    wholeTaka(request.codAmountMinor, 'The cash to collect');
    const outcome = this.settings.outcome ?? 'success';
    const base = outcome.replace(/_once$/, '');
    const misbehave = outcome.endsWith('_once') ? this.firstTime(request.reference, outcome) : true;

    if (misbehave) {
      if (base === 'validation_error')
        throw new CourierError('validation', 'Simulated courier refused the booking', {
          status: 422,
          fields: [{ field: 'recipient_address', message: 'Simulated: address not serviceable' }],
        });
      if (base === 'rate_limited')
        throw new CourierError('rate_limited', 'Simulated courier is rate limiting requests', {
          status: 429,
          retryAfterSeconds: 1,
          outcomeUnknown: false,
        });
      if (base === 'unavailable')
        throw new CourierError('unavailable', 'Simulated courier had a problem', {
          status: 503,
          outcomeUnknown: true,
        });
      if (base === 'timeout_before_booking')
        throw new CourierError('unavailable', 'The simulated courier did not answer', {
          outcomeUnknown: true,
        });
    }

    const list = MOCK_BOOKINGS.get(this.scope) ?? [];
    const existing = list.find((b) => b.reference === request.reference);
    let booking: MockBooking;
    if (existing && this.settings.referenceLookup) booking = existing;
    else {
      // Without a reference lookup a second booking is a second parcel: exactly the duplicate our own controls must prevent.
      const count = (existing?.count ?? 0) + 1;
      booking = {
        reference: request.reference,
        count,
        consignmentId: `SIM-${createHash('sha256').update(`${this.scope}:${request.reference}:${count}`).digest('hex').slice(0, 10).toUpperCase()}`,
      };
      list.push(booking);
      MOCK_BOOKINGS.set(this.scope, list);
    }

    if (misbehave && base === 'timeout_after_booking')
      throw new CourierError('unavailable', 'The simulated courier did not answer', {
        outcomeUnknown: true,
      });

    return {
      consignmentId: booking.consignmentId,
      trackingCode: booking.consignmentId,
      trackingUrl: `https://simulated.invalid/track/${booking.consignmentId}`,
      providerStatus: 'booked',
      status: 'booked',
      deliveryFeeMinor: this.settings.feeMinor ?? 6000,
      raw: { simulated: true, consignment_id: booking.consignmentId },
    };
  }

  async findByReference(reference: string): Promise<TrackingResult | null> {
    if (!this.settings.referenceLookup) return null;
    const found = (MOCK_BOOKINGS.get(this.scope) ?? []).find((b) => b.reference === reference);
    return found
      ? {
          consignmentId: found.consignmentId,
          providerStatus: 'booked',
          status: 'booked',
          raw: { simulated: true },
        }
      : null;
  }

  async track(target: TrackTarget): Promise<TrackingResult> {
    const last = target.last ?? { providerStatus: 'booked', status: 'booked' as const };
    return {
      consignmentId: target.consignmentId,
      providerStatus: last.providerStatus,
      status: last.status,
      raw: { simulated: true },
    };
  }

  async cancel(target: TrackTarget): Promise<{ cancelled: boolean; message?: string }> {
    const status = target.last?.status ?? 'booked';
    return status === 'booked'
      ? { cancelled: true }
      : { cancelled: false, message: 'The simulated courier has already collected this parcel' };
  }
}
