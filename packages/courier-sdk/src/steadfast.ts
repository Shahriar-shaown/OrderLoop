import { CourierError } from './errors.js';
import { Http, RateLimiter, type FetchLike } from './http.js';
import { toLocalPhone, wholeTaka } from './money.js';
import { mapSteadfastStatus } from './status.js';
import type {
  BookingRequest,
  BookingResult,
  Capabilities,
  ConnectionCheck,
  CourierAdapter,
  TrackTarget,
  TrackingResult,
} from './types.js';

/**
 * Steadfast Courier merchant API.
 *
 * Sources (the Postman reference at documenter.getpostman.com/view/26211192/2sAYJ1mhpk is rendered by script and could not be
 * read; see docs/couriers.md): the Laravel package published by the company (github.com/steadfast-it) for the statuses, the
 * create-order fields, the webhook and the base URL `https://portal.steadfast.com.bd/api/v1`; and the community
 * "steadfast-merchant-sdk" for the header names (`Api-Key`, `Secret-Key`), the endpoint paths and the limits (1,000 requests a
 * minute, 6,000 for booking). The same API is also served at `https://portal.packzy.com/api/v1`, the former brand: both hosts
 * are offered and nothing else is allowed.
 *
 * Steadfast documents no estimate endpoint and no cancel endpoint, so neither is offered.
 */
export const STEADFAST_BASE_URLS = {
  steadfast: 'https://portal.steadfast.com.bd/api/v1',
  packzy: 'https://portal.packzy.com/api/v1',
} as const;

export interface SteadfastCredentials {
  apiKey: string;
  secretKey: string;
}
export interface SteadfastSettings {
  host: keyof typeof STEADFAST_BASE_URLS;
}
export interface SteadfastOptions {
  credentials: SteadfastCredentials;
  settings: SteadfastSettings;
  fetch?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  /** Documented as 1,000 a minute; we stay well under. */
  requestsPerMinute?: number | undefined;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined;

const REFERENCE_RE = /^[A-Za-z0-9_-]{1,100}$/;
const DUPLICATE_RE = /already|duplicate|taken|exists/i;

/**
 * Steadfast refused a booking. A refusal that says the invoice is already used means an earlier attempt succeeded, so the
 * outcome is unknown and the caller settles it with `findByReference`; any other refusal created nothing.
 */
function refusedBooking(
  message: string,
  options: ConstructorParameters<typeof CourierError>[2] = {},
): CourierError {
  return new CourierError('validation', message, {
    ...options,
    outcomeUnknown:
      DUPLICATE_RE.test(message) || (options.fields ?? []).some((f) => f.field === 'invoice'),
  });
}

export class SteadfastAdapter implements CourierAdapter {
  readonly provider = 'steadfast' as const;
  readonly simulated = false;
  readonly capabilities: Capabilities = {
    quote: false,
    tracking: true,
    webhooks: true,
    cancel: false,
    returns: true,
    locations: false,
    // `invoice` is the merchant's own unique reference, and the status can be looked up by it: a booking that timed out can be checked.
    duplicateProtection: 'reference',
    // Steadfast documents no weight limit; this is the widest range the API accepts.
    weightKg: { min: 0.1, max: 50 },
  };

  private readonly http: Http;

  constructor(private readonly options: SteadfastOptions) {
    const limiter = new RateLimiter(options.requestsPerMinute ?? 600, options.now, options.sleep);
    this.http = new Http({
      baseUrl: `${STEADFAST_BASE_URLS[options.settings.host]}/`,
      fetch: options.fetch,
      sleep: options.sleep,
      userAgent: 'OrderLoop-courier/1.0 (steadfast)',
      beforeRequest: () => limiter.acquire(),
    });
  }

  private headers(): Record<string, string> {
    return {
      'Api-Key': this.options.credentials.apiKey,
      'Secret-Key': this.options.credentials.secretKey,
    };
  }

  async verifyConnection(): Promise<ConnectionCheck> {
    const body = asRecord(
      await this.http.request({
        method: 'GET',
        path: 'get_balance',
        headers: this.headers(),
        kind: 'idempotent',
      }),
    );
    if (body['current_balance'] === undefined && body['status'] !== 200)
      throw new CourierError('auth', 'Steadfast did not accept the API key and secret key.');
    return { ok: true, details: ['The API key and secret key were accepted.'] };
  }

  async book(request: BookingRequest): Promise<BookingResult> {
    if (!REFERENCE_RE.test(request.reference))
      throw new CourierError(
        'unsupported',
        'The invoice reference may only use letters, digits, - and _.',
      );
    if (request.recipient.name.length > 100)
      throw new CourierError(
        'unsupported',
        'Steadfast takes recipient names up to 100 characters.',
      );
    if (request.recipient.address.length > 490)
      throw new CourierError('unsupported', 'Steadfast takes addresses up to 490 characters.');
    const cod = wholeTaka(request.codAmountMinor, 'The cash to collect');
    if (cod > 1_000_000)
      throw new CourierError('unsupported', 'Steadfast takes cash to collect up to ৳1,000,000.');
    const reply = asRecord(
      await this.createOrder({
        method: 'POST',
        path: 'create_order',
        headers: this.headers(),
        body: {
          invoice: request.reference,
          recipient_name: request.recipient.name,
          recipient_phone: toLocalPhone(request.recipient.phone),
          ...(request.recipient.secondaryPhone
            ? { alternative_phone: toLocalPhone(request.recipient.secondaryPhone) }
            : {}),
          recipient_address: request.recipient.address,
          cod_amount: cod,
          ...(request.note ? { note: request.note.slice(0, 480) } : {}),
          item_description: request.itemDescription.slice(0, 255),
          total_lot: request.itemQuantity,
        },
        kind: 'create',
      }),
    );
    // The reply nests the parcel under `consignment` (one description) or puts its fields at the top (another): accept both.
    const c = asRecord(reply['consignment'] ?? reply);
    if (
      reply['status'] !== undefined &&
      reply['status'] !== 200 &&
      reply['status'] !== 'success' &&
      !c['consignment_id']
    )
      throw refusedBooking(str(reply['message']) ?? 'Steadfast refused the booking');
    const consignmentId = str(c['consignment_id']);
    if (!consignmentId)
      throw new CourierError(
        'unexpected',
        'Steadfast accepted the booking but did not return a consignment id',
        {
          outcomeUnknown: true,
        },
      );
    // In the flat shape `status` is the numeric result code, not a parcel status: only a text value is the parcel's status.
    const providerStatus =
      typeof c['status'] === 'string' && c['status'] ? c['status'] : 'in_review';
    return {
      consignmentId,
      trackingCode: str(c['tracking_code']),
      // Only a link Steadfast itself returned: we do not build tracking addresses of our own.
      trackingUrl: str(c['tracking_link']),
      providerStatus,
      status: mapSteadfastStatus(providerStatus),
      raw: reply,
    };
  }

  /** A create that Steadfast refuses because the invoice exists is a duplicate: the first attempt went through. */
  private async createOrder(request: Parameters<Http['request']>[0]): Promise<unknown> {
    try {
      return await this.http.request(request);
    } catch (error) {
      if (error instanceof CourierError && error.kind === 'validation')
        throw refusedBooking(error.message, { status: error.status, fields: error.fields });
      throw error;
    }
  }

  async findByReference(reference: string): Promise<TrackingResult | null> {
    try {
      return await this.byInvoice(reference);
    } catch (error) {
      if (error instanceof CourierError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  private async byInvoice(reference: string): Promise<TrackingResult> {
    const body = asRecord(
      await this.http.request({
        method: 'GET',
        path: `status_by_invoice/${encodeURIComponent(reference)}`,
        headers: this.headers(),
        kind: 'idempotent',
      }),
    );
    return this.statusOf(body, null);
  }

  private statusOf(body: Record<string, unknown>, consignmentId: string | null): TrackingResult {
    const providerStatus = str(body['delivery_status']);
    if (!providerStatus) {
      // Steadfast answers an unknown invoice or id with a non-200 `status` inside a 200 reply.
      if (body['status'] !== undefined && body['status'] !== 200)
        throw new CourierError('not_found', 'Steadfast has no such parcel');
      throw new CourierError('unexpected', 'Steadfast returned no status for this parcel');
    }
    return {
      consignmentId: consignmentId ?? str(body['consignment_id']) ?? null,
      providerStatus,
      status: mapSteadfastStatus(providerStatus),
      raw: body,
    };
  }

  async track(target: TrackTarget): Promise<TrackingResult> {
    if (!target.consignmentId) return this.byInvoice(target.reference);
    const body = asRecord(
      await this.http.request({
        method: 'GET',
        path: `status_by_cid/${encodeURIComponent(target.consignmentId)}`,
        headers: this.headers(),
        kind: 'idempotent',
      }),
    );
    return this.statusOf(body, target.consignmentId);
  }
}
