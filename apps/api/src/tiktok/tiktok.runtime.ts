import { Inject, Injectable, Optional } from '@nestjs/common';
import { TikTokApiError, TikTokShopClient, type TikTokAuthDeps } from '@orderloop/automation';
import type { TikTokMode } from '@orderloop/contracts';
import { ApiError } from '../common/api-error.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';

/** Tests replace it with a fake network (`{ fetch }`): no test ever reaches TikTok. */
export const TIKTOK_HTTP = Symbol('TIKTOK_HTTP');
/** Tests replace it with a fake clock (expiry of the sign-in state, token expiry). */
export const TIKTOK_NOW = Symbol('TIKTOK_NOW');

/** The TikTok Shop integration's configuration, in one place. */
@Injectable()
export class TikTokRuntime {
  private client: TikTokShopClient | null = null;

  constructor(
    @Inject(APP_CONFIG) readonly config: AppConfig,
    @Optional() @Inject(TIKTOK_HTTP) private readonly http: { fetch?: typeof fetch } = {},
    @Optional() @Inject(TIKTOK_NOW) private readonly clock: (() => Date) | null = null,
  ) {}

  now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  get mode(): TikTokMode {
    return this.config.TIKTOK_MODE;
  }
  get isMock(): boolean {
    return this.config.TIKTOK_MODE === 'mock';
  }

  /**
   * Whether the mock endpoints (create a mock shop, inject a fake order, change its status) exist. Mock mode only, and never in
   * production unless TIKTOK_ALLOW_MOCK_IN_PRODUCTION=true (pilot demos): a mock-mode production server must not let anyone
   * fabricate orders that move real stock.
   */
  get mockEndpointsEnabled(): boolean {
    if (!this.isMock) return false;
    return this.config.NODE_ENV !== 'production' || this.config.TIKTOK_ALLOW_MOCK_IN_PRODUCTION;
  }

  /** Everything the real TikTok needs is set (in mock mode it may be set too: the webhook then works for tests). */
  get liveConfigured(): boolean {
    const c = this.config;
    return Boolean(
      c.TIKTOK_APP_KEY && c.TIKTOK_APP_SECRET && c.API_PUBLIC_URL && c.COURIER_CREDENTIALS_KEY,
    );
  }

  get appKey(): string | null {
    return this.config.TIKTOK_APP_KEY ?? null;
  }
  get appSecret(): string | null {
    return this.config.TIKTOK_APP_SECRET ?? null;
  }

  private apiBase(): string {
    return (this.config.API_PUBLIC_URL ?? `http://localhost:${this.config.API_PORT}`).replace(
      /\/+$/,
      '',
    );
  }
  get webhookUrl(): string {
    return `${this.apiBase()}/v1/webhooks/tiktok-shop`;
  }
  get redirectUri(): string {
    return `${this.apiBase()}/v1/integrations/tiktok-shop/oauth/callback`;
  }
  /** The one-time link `oauth/start` hands out (a top-level navigation to the API, which then sends the browser to TikTok). */
  get beginUrl(): string {
    return `${this.apiBase()}/v1/integrations/tiktok-shop/oauth/begin`;
  }
  /** Where the web app lives; the sign-in redirect returns there. */
  get webAppUrl(): string {
    return (
      this.config.WEB_APP_URL ??
      this.config.WEB_ORIGINS[0] ??
      'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  /** The TikTok client. Only live mode has one. */
  tiktok(): TikTokShopClient {
    if (this.config.TIKTOK_MODE !== 'live' || !this.liveConfigured)
      throw new ApiError(
        'tiktok_not_configured',
        'The real TikTok Shop connection is not set up on this server (TIKTOK_MODE=live with the TIKTOK_* settings).',
      );
    this.client ??= new TikTokShopClient({
      fetch: this.http.fetch ?? fetch,
      appKey: this.config.TIKTOK_APP_KEY!,
      appSecret: this.config.TIKTOK_APP_SECRET!,
      authHost: this.config.TIKTOK_AUTH_HOST,
      apiHost: this.config.TIKTOK_API_HOST,
      version: this.config.TIKTOK_API_VERSION,
      now: () => this.now(),
    });
    return this.client;
  }

  /** What the shared token and sync code needs (the vault is passed in: this class does not own it). */
  authDeps(
    db: TikTokAuthDeps['db'],
    vault: TikTokAuthDeps['vault'],
    log: TikTokAuthDeps['log'],
    metrics?: TikTokAuthDeps['metrics'],
  ): TikTokAuthDeps {
    return {
      db,
      vault,
      log,
      client: this.tiktok(),
      now: () => this.now(),
      ...(metrics ? { metrics } : {}),
    };
  }
}

/** TikTok's failure, in the API's words. TikTok's own text is never forwarded (it can quote what we sent). */
export function tiktokProblem(error: unknown): ApiError {
  if (!(error instanceof TikTokApiError))
    return new ApiError('tiktok_unavailable', 'TikTok could not be reached. Try again shortly.');
  switch (error.kind) {
    case 'token_invalid':
      return new ApiError(
        'tiktok_token_invalid',
        'TikTok no longer accepts this sign-in. Start the connection again.',
      );
    case 'permission':
      return new ApiError(
        'tiktok_permission_denied',
        'TikTok refused: a required permission was not granted, or the app is not approved for that shop. Approve all permissions and try again.',
      );
    case 'rate_limited':
      return new ApiError(
        'rate_limited',
        'TikTok is limiting requests. Wait a moment and try again.',
      );
    case 'bad_request':
      return new ApiError(
        'tiktok_unavailable',
        'TikTok did not accept the request. Check the shop and try again.',
      );
    default:
      return new ApiError('tiktok_unavailable', 'TikTok could not be reached. Try again shortly.');
  }
}
