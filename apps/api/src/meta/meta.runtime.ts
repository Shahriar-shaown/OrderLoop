import { Inject, Injectable, Optional } from '@nestjs/common';
import { MetaGraphClient, MetaGraphError } from '@orderloop/automation';
import { META_SCOPES, type MetaMode } from '@orderloop/contracts';
import { ApiError } from '../common/api-error.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';

/** Tests replace it with a fake network (`{ fetch }`): no test ever reaches Meta. */
export const META_HTTP = Symbol('META_HTTP');
/** Tests replace it with a fake clock (expiry of the sign-in state). */
export const META_NOW = Symbol('META_NOW');

/** The Meta integration's configuration, in one place. */
@Injectable()
export class MetaRuntime {
  private client: MetaGraphClient | null = null;

  constructor(
    @Inject(APP_CONFIG) readonly config: AppConfig,
    @Optional() @Inject(META_HTTP) private readonly http: { fetch?: typeof fetch } = {},
    @Optional() @Inject(META_NOW) private readonly clock: (() => Date) | null = null,
  ) {}

  now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  get mode(): MetaMode {
    return this.config.META_MODE;
  }
  get isMock(): boolean {
    return this.config.META_MODE === 'mock';
  }

  /**
   * Whether the mock endpoints (create a mock connection, inject a fake message) exist. Mock mode only, and never in production
   * unless META_ALLOW_MOCK_IN_PRODUCTION=true (pilot demos): a mock-mode production server must not let anyone fabricate customer
   * messages into real inboxes.
   */
  get mockEndpointsEnabled(): boolean {
    if (!this.isMock) return false;
    return this.config.NODE_ENV !== 'production' || this.config.META_ALLOW_MOCK_IN_PRODUCTION;
  }

  /** Everything the real Meta needs is set (in mock mode it may be set too: the webhook and callbacks then work for tests). */
  get liveConfigured(): boolean {
    const c = this.config;
    return Boolean(
      c.META_APP_ID &&
      c.META_APP_SECRET &&
      c.META_WEBHOOK_VERIFY_TOKEN &&
      c.META_GRAPH_VERSION &&
      c.API_PUBLIC_URL &&
      c.COURIER_CREDENTIALS_KEY,
    );
  }

  get appSecret(): string | null {
    return this.config.META_APP_SECRET ?? null;
  }

  get scopes(): readonly string[] {
    return META_SCOPES;
  }

  private apiBase(): string {
    return (this.config.API_PUBLIC_URL ?? `http://localhost:${this.config.API_PORT}`).replace(
      /\/+$/,
      '',
    );
  }
  get webhookUrl(): string {
    return `${this.apiBase()}/v1/webhooks/meta`;
  }
  get redirectUri(): string {
    return `${this.apiBase()}/v1/integrations/meta/oauth/callback`;
  }
  /** The one-time link `oauth/start` hands out (a top-level navigation to the API, which then sends the browser to Meta). */
  get beginUrl(): string {
    return `${this.apiBase()}/v1/integrations/meta/oauth/begin`;
  }
  get dataDeletionUrl(): string {
    return `${this.apiBase()}/v1/webhooks/meta/data-deletion/status`;
  }
  /** Where the web app lives; the sign-in redirect returns there. */
  get webAppUrl(): string {
    return (
      this.config.WEB_APP_URL ??
      this.config.WEB_ORIGINS[0] ??
      'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  /** The Graph client. Only live mode has one. */
  graph(): MetaGraphClient {
    if (this.config.META_MODE !== 'live' || !this.liveConfigured)
      throw new ApiError(
        'meta_not_configured',
        'The real Meta connection is not set up on this server (META_MODE=live with the META_* settings).',
      );
    this.client ??= new MetaGraphClient({
      fetch: this.http.fetch ?? fetch,
      version: this.config.META_GRAPH_VERSION!,
      appId: this.config.META_APP_ID!,
      appSecret: this.config.META_APP_SECRET!,
      loginConfigId: this.config.META_LOGIN_CONFIG_ID,
    });
    return this.client;
  }
}

/** Meta's failure, in the API's words. Meta's own text is never forwarded (it can quote what we sent). */
export function graphProblem(error: unknown): ApiError {
  if (!(error instanceof MetaGraphError))
    return new ApiError('meta_unavailable', 'Meta could not be reached. Try again shortly.');
  // Unverified heuristic: Meta's wording when Instagram message access is off. See docs/meta.md.
  if (/access to messages|allow access/i.test(error.message))
    return new ApiError(
      'meta_messages_access_off',
      'Turn on "Allow Access to Messages" in the Instagram app (Message controls, Connected tools), then try again.',
    );
  switch (error.kind) {
    case 'token_invalid':
      return new ApiError(
        'meta_token_invalid',
        'Meta no longer accepts this sign-in. Start the connection again.',
      );
    case 'permission':
      return new ApiError(
        'meta_permission_denied',
        'Meta refused: a required permission was not granted, or you are not an admin of that Page. Approve all permissions and try again.',
      );
    case 'rate_limited':
      return new ApiError(
        'rate_limited',
        'Meta is limiting requests. Wait a moment and try again.',
      );
    case 'bad_request':
      return new ApiError(
        'meta_unavailable',
        'Meta did not accept the request. Check the Page and try again.',
      );
    default:
      return new ApiError('meta_unavailable', 'Meta could not be reached. Try again shortly.');
  }
}
