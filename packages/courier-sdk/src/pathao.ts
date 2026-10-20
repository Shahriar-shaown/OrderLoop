import { CourierError } from './errors.js';
import { Http, RateLimiter, type FetchLike } from './http.js';
import { takaToMinor, toLocalPhone, wholeTaka } from './money.js';
import { mapPathaoStatus } from './status.js';
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
 * Pathao Courier merchant API.
 *
 * Where each detail comes from (the official reference is behind the merchant login at merchant.pathao.com/courier/developer-api
 * and could not be read; see docs/couriers.md):
 *   - OFFICIAL SOURCE (Pathao's own plugin, github.com/pathao-eng/courier-woocommerce-plugin): base URLs, `POST
 *     /aladdin/api/v1/external/login` with client id and secret, stores, city/zone/area lists, `POST /aladdin/api/v1/orders`
 *     and its fields, and the webhook handshake.
 *   - COMMUNITY SDKs ONLY (unverified against Pathao's own docs): the password-grant `issue-token` endpoint, `POST
 *     /aladdin/api/v1/merchant/price-plan`, and `GET /aladdin/api/v1/orders/{consignment_id}/info`.
 * Nothing here is an endpoint we could not find in at least one source. Pathao documents no cancel endpoint, so cancelling is
 * not supported.
 */
export const PATHAO_BASE_URLS = {
  sandbox: 'https://courier-api-sandbox.pathao.com',
  production: 'https://api-hermes.pathao.com',
} as const;

export interface PathaoCredentials {
  clientId: string;
  clientSecret: string;
  /** With a password, the merchant-login (password grant) token endpoint is used instead of the client-credentials one. */
  username?: string | undefined;
  password?: string | undefined;
}

export interface PathaoSettings {
  environment: keyof typeof PATHAO_BASE_URLS;
  storeId?: number | undefined;
  /** 48 normal, 12 on demand. */
  deliveryType?: number | undefined;
  /** 1 document, 2 parcel. */
  itemType?: number | undefined;
  defaultWeightKg?: number | undefined;
}

export interface PathaoOptions {
  credentials: PathaoCredentials;
  settings: PathaoSettings;
  fetch?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  /** Pathao documents no limit; the community reports about 60 a minute, so that is the cautious default. */
  requestsPerMinute?: number | undefined;
}

interface Token {
  value: string;
  expiresAt: number;
}

const API = '/aladdin/api/v1';
/** Tokens are renewed a little early. */
const TOKEN_MARGIN_MS = 60_000;

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined;

/** The largest COD percentage believed sane, in basis points (20%). A bigger number means we misread the unit: no estimate. */
const MAX_COD_BASIS_POINTS = 2000;

/**
 * An estimate of Pathao's charge for collecting cash. `cod_percentage` is read as a fraction ("0.01" is 1%, as in the
 * community SDK's example) and parsed from its decimal text into basis points, so no float touches the money. Its unit is not
 * confirmed by Pathao, so the caller says so; a value that is not a plain number or is above the cap gives no estimate.
 */
export function codFeeEstimate(codAmountMinor: number, percentage: unknown): number | undefined {
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(percentage ?? '').trim());
  if (!m || !Number.isSafeInteger(codAmountMinor) || codAmountMinor <= 0) return undefined;
  const basisPoints = Number(m[1]) * 10_000 + Number((m[2] ?? '').padEnd(4, '0'));
  if (basisPoints <= 0 || basisPoints > MAX_COD_BASIS_POINTS) return undefined;
  const fee = Math.floor((codAmountMinor * basisPoints + 5_000) / 10_000);
  return Number.isSafeInteger(fee) ? fee : undefined;
}

/** A location id the caller gave, or undefined when none was. One that is not a positive whole number is refused, not dropped. */
function optionalId(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0)
    throw new CourierError('unsupported', `The Pathao ${label} id is not valid. Choose it again.`);
  return id;
}

/** Pathao wraps answers as `{ type, code, message, data }`. */
const data = (body: unknown): Record<string, unknown> => asRecord(asRecord(body)['data']);

export class PathaoAdapter implements CourierAdapter {
  readonly provider = 'pathao' as const;
  readonly simulated = false;
  readonly capabilities: Capabilities = {
    quote: true,
    tracking: true,
    webhooks: true,
    cancel: false,
    returns: true,
    locations: true,
    // Pathao documents no lookup by our reference, so a booking that timed out cannot be checked. It must be settled by a person.
    duplicateProtection: 'none',
    weightKg: { min: 0.5, max: 10 },
  };

  private readonly http: Http;
  private readonly now: () => number;
  private token: Token | undefined;
  private authenticating: Promise<Token> | undefined;

  constructor(private readonly options: PathaoOptions) {
    const limiter = new RateLimiter(options.requestsPerMinute ?? 60, options.now, options.sleep);
    this.now = options.now ?? Date.now;
    this.http = new Http({
      baseUrl: PATHAO_BASE_URLS[options.settings.environment],
      fetch: options.fetch,
      sleep: options.sleep,
      userAgent: 'OrderLoop-courier/1.0 (pathao)',
      beforeRequest: () => limiter.acquire(),
    });
  }

  // ---- authentication ------------------------------------------------------------------------------------------------

  private async authenticate(): Promise<Token> {
    // One login at a time, however many requests are waiting for a token.
    this.authenticating ??= this.login().finally(() => (this.authenticating = undefined));
    return this.authenticating;
  }

  private async login(): Promise<Token> {
    const c = this.options.credentials;
    const withPassword = !!(c.username && c.password);
    const body = withPassword
      ? {
          client_id: c.clientId,
          client_secret: c.clientSecret,
          username: c.username,
          password: c.password,
          grant_type: 'password',
        }
      : { client_id: c.clientId, client_secret: c.clientSecret };
    const reply = asRecord(
      await this.http.request({
        method: 'POST',
        path: `${API}/${withPassword ? 'issue-token' : 'external/login'}`,
        body,
        // A login has no side effects worth protecting, and a failed one is not retried in a loop.
        kind: 'idempotent',
      }),
    );
    const access = str(reply['access_token']) ?? str(data(reply)['access_token']);
    if (!access)
      throw new CourierError(
        'auth',
        'Pathao did not return an access token. Check the client id and secret.',
      );
    const seconds = Number(reply['expires_in'] ?? data(reply)['expires_in']);
    this.token = {
      value: access,
      expiresAt:
        this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3_600_000),
    };
    return this.token;
  }

  private async bearer(): Promise<string> {
    const t =
      this.token && this.token.expiresAt - TOKEN_MARGIN_MS > this.now()
        ? this.token
        : await this.authenticate();
    return `Bearer ${t.value}`;
  }

  /** An authenticated request. A 401 means the token went stale: log in again and retry once (the first try did nothing). */
  private async call<T>(r: Parameters<Http['request']>[0]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.http.request<T>({
          ...r,
          headers: { ...r.headers, Authorization: await this.bearer() },
        });
      } catch (error) {
        if (attempt === 0 && error instanceof CourierError && error.kind === 'auth' && this.token) {
          this.token = undefined;
          continue;
        }
        throw error;
      }
    }
  }

  // ---- the adapter ---------------------------------------------------------------------------------------------------

  async verifyConnection(): Promise<ConnectionCheck> {
    await this.authenticate();
    const stores = await this.stores();
    return {
      ok: true,
      details:
        stores.length === 0
          ? [
              'Credentials accepted, but the account has no stores yet. Create one in the Pathao merchant panel.',
            ]
          : stores.map((s) => `Store ${s.id}: ${s.name}${s.active ? '' : ' (not active)'}`),
    };
  }

  async stores(): Promise<{ id: number; name: string; active: boolean }[]> {
    const body = await this.call({ method: 'GET', path: `${API}/stores`, kind: 'idempotent' });
    const items = asRecord(data(body))['data'];
    return (Array.isArray(items) ? items : []).map((s) => {
      const r = asRecord(s);
      return {
        id: Number(r['store_id']),
        name: str(r['store_name']) ?? 'Store',
        active: r['is_active'] !== 0 && r['is_active'] !== false,
      };
    });
  }

  locations = {
    cities: () => this.list(`${API}/countries/1/city-list`, 'city_id', 'city_name'),
    zones: (cityId: number) =>
      this.list(`${API}/cities/${Number(cityId)}/zone-list`, 'zone_id', 'zone_name'),
    areas: (zoneId: number) =>
      this.list(`${API}/zones/${Number(zoneId)}/area-list`, 'area_id', 'area_name'),
  };

  private async list(path: string, idKey: string, nameKey: string): Promise<LocationItem[]> {
    const body = await this.call({ method: 'GET', path, kind: 'idempotent' });
    const items = asRecord(data(body))['data'];
    return (Array.isArray(items) ? items : []).map((i) => {
      const r = asRecord(i);
      return {
        id: Number(r[idKey]),
        name: str(r[nameKey]) ?? '',
        ...(r['home_delivery_available'] !== undefined
          ? { homeDelivery: Boolean(r['home_delivery_available']) }
          : {}),
        ...(r['pickup_available'] !== undefined ? { pickup: Boolean(r['pickup_available']) } : {}),
      };
    });
  }

  private storeId(options: Record<string, unknown> | undefined): number {
    const id = Number(options?.['storeId'] ?? this.options.settings.storeId);
    if (!Number.isInteger(id) || id <= 0)
      throw new CourierError('unsupported', 'Choose a Pathao store in the courier settings first.');
    return id;
  }

  async quote(request: QuoteRequest): Promise<QuoteResult> {
    const o = request.options;
    const city = Number(o?.['cityId']);
    const zone = Number(o?.['zoneId']);
    if (!Number.isInteger(city) || !Number.isInteger(zone) || city <= 0 || zone <= 0)
      throw new CourierError(
        'unsupported',
        'Pathao prices by city and zone: choose both to get a delivery fee.',
      );
    const body = await this.call({
      method: 'POST',
      path: `${API}/merchant/price-plan`,
      body: {
        store_id: this.storeId(o),
        item_type: Number(o?.['itemType'] ?? this.options.settings.itemType ?? 2),
        delivery_type: Number(o?.['deliveryType'] ?? this.options.settings.deliveryType ?? 48),
        item_weight: request.weightKg ?? this.options.settings.defaultWeightKg ?? 0.5,
        recipient_city: city,
        recipient_zone: zone,
      },
      // A price lookup changes nothing, so a transient failure may be retried.
      kind: 'idempotent',
    });
    const d = data(body);
    const fee = takaToMinor(d['final_price'] ?? d['price']);
    const codFeeMinor = codFeeEstimate(request.codAmountMinor, d['cod_percentage']);
    return {
      serviceable: fee === undefined ? null : true,
      ...(fee !== undefined ? { feeMinor: fee } : {}),
      ...(d['cod_enabled'] !== undefined ? { codEnabled: Boolean(d['cod_enabled']) } : {}),
      ...(codFeeMinor !== undefined ? { codFeeMinor } : {}),
      notes: [
        'Pathao fee, as quoted now. The final charge is set by Pathao when the parcel is collected.',
        ...(codFeeMinor !== undefined
          ? [
              'The COD charge is only an estimate: Pathao does not document the unit of its cod_percentage, so it is read as a fraction (0.01 is 1%).',
            ]
          : []),
      ],
      raw: body,
    };
  }

  async book(request: BookingRequest): Promise<BookingResult> {
    const o = request.options;
    const weight = request.weightKg ?? this.options.settings.defaultWeightKg ?? 0.5;
    const { min, max } = this.capabilities.weightKg;
    if (!Number.isFinite(weight) || weight < min || weight > max)
      throw new CourierError('unsupported', `Pathao takes parcels of ${min} to ${max} kg.`);
    if (request.recipient.address.trim().length < 10)
      throw new CourierError(
        'unsupported',
        'Pathao needs a delivery address of at least 10 characters.',
      );
    const city = optionalId(o?.['cityId'], 'city');
    const zone = optionalId(o?.['zoneId'], 'zone');
    const area = optionalId(o?.['areaId'], 'area');
    const reply = await this.call({
      method: 'POST',
      path: `${API}/orders`,
      body: {
        store_id: this.storeId(o),
        merchant_order_id: request.reference,
        recipient_name: request.recipient.name,
        recipient_phone: toLocalPhone(request.recipient.phone),
        recipient_secondary_phone: request.recipient.secondaryPhone
          ? toLocalPhone(request.recipient.secondaryPhone)
          : '',
        recipient_address: request.recipient.address,
        ...(city ? { recipient_city: city } : {}),
        ...(zone ? { recipient_zone: zone } : {}),
        ...(area ? { recipient_area: area } : {}),
        delivery_type: Number(o?.['deliveryType'] ?? this.options.settings.deliveryType ?? 48),
        item_type: Number(o?.['itemType'] ?? this.options.settings.itemType ?? 2),
        special_instruction: request.note ?? '',
        item_quantity: request.itemQuantity,
        item_weight: weight,
        item_description: request.itemDescription,
        amount_to_collect: wholeTaka(request.codAmountMinor, 'The cash to collect'),
      },
      // Pathao documents no way to look a booking up by our reference, so a repeat after an unknown outcome could book twice.
      kind: 'create',
    });
    const d = data(reply);
    const consignmentId = str(d['consignment_id']);
    if (!consignmentId)
      throw new CourierError(
        'unexpected',
        'Pathao accepted the booking but did not return a consignment id',
        {
          outcomeUnknown: true,
        },
      );
    const providerStatus = str(d['order_status']) ?? 'Pending';
    const fee = takaToMinor(d['delivery_fee']);
    return {
      consignmentId,
      providerStatus,
      status: mapPathaoStatus(providerStatus) ?? 'booked',
      ...(fee !== undefined ? { deliveryFeeMinor: fee } : {}),
      raw: reply,
    };
  }

  async track(target: TrackTarget): Promise<TrackingResult> {
    if (!target.consignmentId)
      throw new CourierError(
        'unsupported',
        'Pathao tracks by consignment id, and this booking has none.',
      );
    const body = await this.call({
      method: 'GET',
      path: `${API}/orders/${encodeURIComponent(target.consignmentId)}/info`,
      kind: 'idempotent',
    });
    const d = data(body);
    const providerStatus = str(d['order_status_slug']) ?? str(d['order_status']);
    if (!providerStatus)
      throw new CourierError('unexpected', 'Pathao returned no status for this parcel');
    const fee = takaToMinor(d['delivery_fee']);
    return {
      consignmentId: str(d['consignment_id']) ?? target.consignmentId,
      providerStatus: str(d['order_status']) ?? providerStatus,
      status: mapPathaoStatus(providerStatus) ?? 'unknown',
      updatedAt: str(d['updated_at']),
      ...(fee !== undefined ? { deliveryFeeMinor: fee } : {}),
      raw: body,
    };
  }
}
