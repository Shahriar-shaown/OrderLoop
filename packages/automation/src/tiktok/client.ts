import { tikTokExpiry } from '@orderloop/domain';
import { tiktokRequestSignature } from './signature.js';

/**
 * The ONE place that talks to TikTok Shop. Small on purpose: `fetch` is injected (tests pass a fake, nothing real is ever
 * called from a test), every call has a timeout, every API request is signed as the SDK sources describe, the hosts and the API
 * version come from configuration, and no token, secret or auth code ever appears in a log line or an error message (they are
 * replaced by `[token]`). The `code` and `message` of TikTok's response envelope are always read: HTTP 200 does not mean success.
 *
 * Written against the EcomPHP/tiktokshop-php sources (cross-checked with hsib19/tiktok-shop-sdk). NEVER run against TikTok: no
 * credentials exist for a Bangladesh business. Paths, parameters and field names are unverified against partner.tiktokshop.com:
 * see docs/tiktok-shop.md before relying on any of it.
 */

export type TikTokErrorKind =
  | 'token_invalid' // the access or refresh token (or the auth code) is expired, revoked or wrong
  | 'permission' // a scope is missing, or the app is not allowed for this shop
  | 'rate_limited' // retry later
  | 'bad_request' // a parameter is wrong
  | 'unavailable'; // network failure, timeout, 5xx, or an answer that is not TikTok's envelope

export class TikTokApiError extends Error {
  constructor(
    readonly kind: TikTokErrorKind,
    message: string,
    readonly httpStatus: number | null,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'TikTokApiError';
  }

  /** Worth trying again later without anyone doing anything. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}

/**
 * Which kind of failure an envelope is. TikTok's numeric codes could not be verified (the documentation is not readable), so this
 * leans on the HTTP status and on the words of the message; only the two token codes that every SDK mentions are listed
 * (VERIFY: 105001 / 105002 are token problems in TikTok's tables). Anything unrecognised is a bad request, never a retry loop.
 */
const TOKEN_CODES = new Set([105001, 105002, 105003]);
export function classifyTikTokError(
  httpStatus: number | null,
  code: number | null,
  message: string,
): TikTokErrorKind {
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus !== null && httpStatus >= 500) return 'unavailable';
  if (httpStatus === 401) return 'token_invalid';
  if (code !== null && TOKEN_CODES.has(code)) return 'token_invalid';
  if (
    /(access|refresh)[ _-]?token|auth[ _-]?code|expired|invalid[ _-]?(token|credential|grant)|unauthori[sz]ed/i.test(
      message,
    )
  )
    return 'token_invalid';
  if (/\brate\b|rate[ _-]?limit|too many|frequen|throttl|quota|limit exceed/i.test(message))
    return 'rate_limited';
  if (
    httpStatus === 403 ||
    /permission|scope|not authori[sz]ed|forbidden|no access|denied/i.test(message)
  )
    return 'permission';
  return 'bad_request';
}

export interface TikTokClientConfig {
  fetch: typeof fetch;
  appKey: string;
  appSecret: string;
  /** e.g. `https://auth.tiktok-shops.com` */
  authHost: string;
  /** e.g. `https://open-api.tiktokglobalshop.com` */
  apiHost: string;
  /** e.g. `202309`: part of every API path. */
  version: string;
  /** Per call. Default 8 s. */
  timeoutMs?: number;
  /** Seconds-resolution clock for the signed `timestamp`, and for token expiry. Default: the real clock. */
  now?: () => Date;
}

/** What the token endpoints return, with the expiries already read (see `tikTokExpiry`). */
export interface TikTokGrant {
  accessToken: string;
  refreshToken: string;
  /** Null when TikTok did not say: the caller then renews early rather than guessing. */
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  scopes: string[];
}

export interface TikTokShopInfo {
  id: string;
  /** Needed by every shop-level call. */
  cipher: string;
  name: string;
  region: string | null;
  sellerType: string | null;
}

/** What a shop-level call needs: the access token (header) and the shop cipher (signed query parameter). */
export interface ShopContext {
  accessToken: string;
  shopCipher: string | null;
}

export interface OrderSearch {
  /** Epoch seconds, inclusive. */
  updateTimeGe: number;
  /** Epoch seconds, exclusive. */
  updateTimeLt: number;
  pageToken?: string | undefined;
  pageSize?: number | undefined;
}

export interface OrderSearchPage {
  /** TikTok's order objects, untouched. They hold buyer data: pass them straight to `parseTikTokOrder`, which keeps none of it. */
  orders: unknown[];
  nextPageToken: string | null;
  total: number | null;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Paths that must not carry `shop_cipher` (the SDK removes it for these). */
const NO_CIPHER = /^\/(authorization|seller)\//;

export class TikTokShopClient {
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly cfg: TikTokClientConfig) {
    this.timeoutMs = cfg.timeoutMs ?? 8000;
    this.now = cfg.now ?? (() => new Date());
  }

  /** Remove anything that looks like a secret we hold from text that may be logged or shown. */
  private redact(text: string, extra: readonly string[] = []): string {
    let out = text;
    for (const secret of [this.cfg.appSecret, ...extra])
      if (secret) out = out.split(secret).join('[token]');
    return out.replace(
      /(access_token|refresh_token|app_secret|auth_code|x-tts-access-token|sign)=[^&\s"']+/gi,
      '$1=[token]',
    );
  }

  private async send(
    url: string,
    init: RequestInit,
    secrets: readonly string[],
  ): Promise<{ status: number; body: Json }> {
    let res: Response;
    try {
      res = await this.cfg.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new TikTokApiError(
        'unavailable',
        timedOut ? 'TikTok did not answer in time' : 'TikTok could not be reached',
        null,
        null,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TikTokApiError(
        res.status === 429 ? 'rate_limited' : 'unavailable',
        'TikTok answered with something that is not JSON',
        res.status,
        null,
      );
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new TikTokApiError(
        'unavailable',
        'TikTok answered with an unexpected shape',
        res.status,
        null,
      );
    const envelope = body as Json;
    // TikTok's envelope: { code, message, request_id, data }. Zero is success; HTTP 200 alone is not.
    const code = typeof envelope['code'] === 'number' ? (envelope['code'] as number) : null;
    if (!res.ok || code !== 0) {
      const message =
        typeof envelope['message'] === 'string'
          ? (envelope['message'] as string)
          : `HTTP ${res.status}`;
      throw new TikTokApiError(
        classifyTikTokError(res.status, code, message),
        this.redact(message, secrets).slice(0, 200),
        res.status,
        code,
      );
    }
    return { status: res.status, body: envelope };
  }

  // ---- sign-in and tokens ------------------------------------------------------------------------------------------------

  /** The page to send the seller to. The `state` comes back unchanged to the registered redirect address. */
  authorizeUrl(state: string): string {
    const q = new URLSearchParams({ app_key: this.cfg.appKey, state });
    return `${this.cfg.authHost.replace(/\/+$/, '')}/oauth/authorize?${q.toString()}`;
  }

  private async tokenCall(
    path: '/api/v2/token/get' | '/api/v2/token/refresh',
    params: Record<string, string>,
    secret: string,
  ): Promise<TikTokGrant> {
    const q = new URLSearchParams({
      app_key: this.cfg.appKey,
      app_secret: this.cfg.appSecret,
      ...params,
    });
    const { body } = await this.send(
      `${this.cfg.authHost.replace(/\/+$/, '')}${path}?${q.toString()}`,
      { method: 'GET' },
      [secret],
    );
    const d = (body['data'] ?? {}) as Json;
    const accessToken = str(d['access_token']);
    const refreshToken = str(d['refresh_token']);
    if (!accessToken)
      throw new TikTokApiError('unavailable', 'TikTok answered without an access token', 200, 0);
    const now = this.now();
    const scopes = Array.isArray(d['granted_scopes'])
      ? (d['granted_scopes'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    return {
      accessToken,
      // A refresh answer that carries no new refresh token leaves the old one valid.
      refreshToken: refreshToken ?? '',
      accessExpiresAt: tikTokExpiry(d['access_token_expire_in'], now),
      refreshExpiresAt: tikTokExpiry(d['refresh_token_expire_in'], now),
      scopes,
    };
  }

  /** The one-time `auth_code` from the redirect -> the token pair. */
  exchangeCode(authCode: string): Promise<TikTokGrant> {
    return this.tokenCall(
      '/api/v2/token/get',
      { auth_code: authCode, grant_type: 'authorized_code' },
      authCode,
    );
  }

  /** The refresh token -> a new token pair. The refresh token may be single use: store the answer atomically. */
  refresh(refreshToken: string): Promise<TikTokGrant> {
    return this.tokenCall(
      '/api/v2/token/refresh',
      { refresh_token: refreshToken, grant_type: 'refresh_token' },
      refreshToken,
    );
  }

  // ---- shop APIs ----------------------------------------------------------------------------------------------------------

  private async api(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    ctx: ShopContext,
    opts: { query?: Record<string, string | undefined>; body?: object } = {},
  ): Promise<Json> {
    const timestamp = String(Math.floor(this.now().getTime() / 1000));
    const query: Record<string, string | undefined> = {
      ...opts.query,
      app_key: this.cfg.appKey,
      timestamp,
      ...(ctx.shopCipher && !NO_CIPHER.test(path) ? { shop_cipher: ctx.shopCipher } : {}),
    };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const sign = tiktokRequestSignature({
      path,
      query,
      body: method === 'GET' ? '' : (body ?? ''),
      appSecret: this.cfg.appSecret,
    });
    const url = new URLSearchParams(
      Object.entries({ ...query, sign }).filter((e): e is [string, string] => e[1] !== undefined),
    );
    const { body: envelope } = await this.send(
      `${this.cfg.apiHost.replace(/\/+$/, '')}${path}?${url.toString()}`,
      {
        method,
        headers: { 'content-type': 'application/json', 'x-tts-access-token': ctx.accessToken },
        ...(method === 'GET' || body === undefined ? {} : { body }),
      },
      [ctx.accessToken],
    );
    return (envelope['data'] ?? {}) as Json;
  }

  /** The shops this authorisation covers (with each shop's cipher). */
  async getAuthorizedShops(accessToken: string): Promise<TikTokShopInfo[]> {
    const data = await this.api('GET', `/authorization/${this.cfg.version}/shops`, {
      accessToken,
      shopCipher: null,
    });
    const shops = Array.isArray(data['shops']) ? (data['shops'] as Json[]) : [];
    const out: TikTokShopInfo[] = [];
    for (const s of shops) {
      const id = str(s['id']);
      const cipher = str(s['cipher']);
      if (!id || !cipher) continue;
      out.push({
        id,
        cipher,
        name: str(s['name']) ?? id,
        region: str(s['region']),
        sellerType: str(s['seller_type']),
      });
    }
    return out;
  }

  /** One page of orders changed in a time window, oldest change first so a bounded run always makes progress. */
  async searchOrders(ctx: ShopContext, search: OrderSearch): Promise<OrderSearchPage> {
    const data = await this.api('POST', `/order/${this.cfg.version}/orders/search`, ctx, {
      query: {
        page_size: String(search.pageSize ?? 50),
        sort_field: 'update_time',
        sort_order: 'ASC',
        page_token: search.pageToken,
      },
      body: { update_time_ge: search.updateTimeGe, update_time_lt: search.updateTimeLt },
    });
    return {
      orders: Array.isArray(data['orders']) ? (data['orders'] as unknown[]) : [],
      nextPageToken: str(data['next_page_token']),
      total: typeof data['total_count'] === 'number' ? (data['total_count'] as number) : null,
    };
  }

  /** Full order objects by id (at most 50 per call). Ids TikTok does not know are simply absent from the answer. */
  async getOrders(ctx: ShopContext, ids: readonly string[]): Promise<unknown[]> {
    if (ids.length === 0) return [];
    const data = await this.api('GET', `/order/${this.cfg.version}/orders`, ctx, {
      query: { ids: ids.slice(0, 50).join(',') },
    });
    return Array.isArray(data['orders']) ? (data['orders'] as unknown[]) : [];
  }

  /** Events API: point one event type at our webhook address (replaces what was there). */
  async updateWebhook(ctx: ShopContext, eventType: string, address: string): Promise<void> {
    await this.api('PUT', `/event/${this.cfg.version}/webhooks`, ctx, {
      body: { address, event_type: eventType },
    });
  }
}
