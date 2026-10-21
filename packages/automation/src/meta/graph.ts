/**
 * The ONE place that talks to Meta's Graph API. Small on purpose: `fetch` is injected (tests pass a fake, nothing real is
 * ever called from a test), every call has a timeout, the version is pinned by configuration, and no token ever appears in a
 * log line or an error message (they are replaced by `[token]`).
 *
 * Written against Meta's documentation. NOT tested with authorised credentials: see docs/meta.md.
 */

export type MetaErrorKind =
  | 'token_invalid' // code 190: the token is expired, revoked or the person changed their password
  | 'permission' // codes 10, 200, 299 (and 3, 283 by their description): a permission is missing or was removed
  | 'rate_limited' // codes 4, 17, 32, 613: retry later
  | 'bad_request' // code 100: a parameter is wrong (an id we do not have access to, a field that does not exist)
  | 'unavailable'; // network failure, timeout, 5xx, or an answer that is not a Graph answer

export class MetaGraphError extends Error {
  constructor(
    readonly kind: MetaErrorKind,
    message: string,
    readonly httpStatus: number | null,
    readonly code: number | null,
    readonly subcode: number | null = null,
  ) {
    super(message);
    this.name = 'MetaGraphError';
  }

  /** Worth trying again later without anyone doing anything. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}

/** The kind for a Graph error code. Only codes documented by Meta are mapped; anything else is a bad request or unavailable. */
export function kindOfGraphError(code: number | null, httpStatus: number | null): MetaErrorKind {
  if (code === 190) return 'token_invalid';
  if (code === 10 || code === 200 || code === 299) return 'permission';
  if (code === 4 || code === 17 || code === 32 || code === 613) return 'rate_limited';
  if (code === 100) return 'bad_request';
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus !== null && httpStatus >= 500) return 'unavailable';
  if (httpStatus === 401) return 'token_invalid';
  if (httpStatus === 403) return 'permission';
  return 'bad_request';
}

export interface GraphConfig {
  fetch: typeof fetch;
  /** Pinned, e.g. `v23.0`. */
  version: string;
  appId: string;
  appSecret: string;
  /** Per call. Default 8 s. */
  timeoutMs?: number;
  /** Optional Facebook Login for Business configuration id (replaces `scope` in the dialog). */
  loginConfigId?: string | undefined;
}

export interface GraphPage {
  id: string;
  name: string;
  /** The Page access token. Handle like a password. */
  accessToken: string;
  tasks: string[];
  instagram: { id: string; username: string | null } | null;
}

export interface TokenDebug {
  isValid: boolean;
  scopes: string[] | null;
  expiresAt: number | null;
  appId: string | null;
}

type Json = Record<string, unknown>;

export class MetaGraphClient {
  private readonly timeoutMs: number;

  constructor(private readonly cfg: GraphConfig) {
    this.timeoutMs = cfg.timeoutMs ?? 8000;
  }

  /** Remove anything that looks like a secret we hold from text that may be logged or shown. */
  private redact(text: string, extra: string[] = []): string {
    let out = text;
    for (const secret of [this.cfg.appSecret, ...extra])
      if (secret) out = out.split(secret).join('[token]');
    return out
      .replace(
        /(access_token|client_secret|fb_exchange_token|input_token|code)=[^&\s"']+/gi,
        '$1=[token]',
      )
      .replace(/\bEA[A-Za-z0-9]{20,}\b/g, '[token]');
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | undefined>,
    secrets: string[] = [],
  ): Promise<T> {
    const clean = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined);
    const query = new URLSearchParams(clean).toString();
    const base = `https://graph.facebook.com/${this.cfg.version}/${path.replace(/^\/+/, '')}`;
    // Tokens travel in the query (GET, DELETE) or the form body (POST), as Meta documents; never in a log line.
    const url = method === 'POST' ? base : `${base}?${query}`;
    let res: Response;
    try {
      res = await this.cfg.fetch(url, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(method === 'POST'
          ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: query }
          : {}),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new MetaGraphError(
        'unavailable',
        timedOut ? 'Meta did not answer in time' : 'Meta could not be reached',
        null,
        null,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new MetaGraphError(
        'unavailable',
        'Meta answered with something that is not JSON',
        res.status,
        null,
      );
    }
    const err = (body as { error?: Json } | null)?.error;
    if (!res.ok || err) {
      const code = typeof err?.['code'] === 'number' ? (err['code'] as number) : null;
      const subcode =
        typeof err?.['error_subcode'] === 'number' ? (err['error_subcode'] as number) : null;
      const message =
        typeof err?.['message'] === 'string' ? (err['message'] as string) : `HTTP ${res.status}`;
      throw new MetaGraphError(
        kindOfGraphError(code, res.status),
        this.redact(message, secrets).slice(0, 300),
        res.status,
        code,
        subcode,
      );
    }
    return body as T;
  }

  // ---- OAuth ---------------------------------------------------------------------------------------------------------

  /** The dialog to send the person to. Only the scopes asked for are requested. */
  authorizeUrl(opts: { redirectUri: string; state: string; scopes: readonly string[] }): string {
    const q = new URLSearchParams({
      client_id: this.cfg.appId,
      redirect_uri: opts.redirectUri,
      state: opts.state,
      response_type: 'code',
    });
    if (this.cfg.loginConfigId) {
      q.set('config_id', this.cfg.loginConfigId);
      q.set('override_default_response_type', 'true');
    } else q.set('scope', opts.scopes.join(','));
    return `https://www.facebook.com/${this.cfg.version}/dialog/oauth?${q.toString()}`;
  }

  /** The one-time `code` from the redirect -> a short-lived user token. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const r = await this.call<{ access_token: string }>(
      'GET',
      'oauth/access_token',
      {
        client_id: this.cfg.appId,
        client_secret: this.cfg.appSecret,
        redirect_uri: redirectUri,
        code,
      },
      [code],
    );
    return r.access_token;
  }

  /** Short-lived user token -> long-lived one (which yields Page tokens that do not expire). */
  async exchangeLongLived(
    shortToken: string,
  ): Promise<{ token: string; expiresIn: number | null }> {
    const r = await this.call<{ access_token: string; expires_in?: number }>(
      'GET',
      'oauth/access_token',
      {
        grant_type: 'fb_exchange_token',
        client_id: this.cfg.appId,
        client_secret: this.cfg.appSecret,
        fb_exchange_token: shortToken,
      },
      [shortToken],
    );
    return { token: r.access_token, expiresIn: r.expires_in ?? null };
  }

  async me(token: string): Promise<{ id: string; name: string | null }> {
    const r = await this.call<{ id: string; name?: string }>(
      'GET',
      'me',
      { fields: 'id,name', access_token: token },
      [token],
    );
    return { id: r.id, name: r.name ?? null };
  }

  /** The Pages the person manages, with their Page tokens and linked Instagram accounts. */
  async listPages(userToken: string): Promise<GraphPage[]> {
    const pages: GraphPage[] = [];
    let after: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await this.call<{
        data: {
          id: string;
          name: string;
          access_token: string;
          tasks?: string[];
          instagram_business_account?: { id: string; username?: string };
        }[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>(
        'GET',
        'me/accounts',
        {
          fields: 'id,name,access_token,tasks,instagram_business_account{id,username}',
          limit: '100',
          ...(after ? { after } : {}),
          access_token: userToken,
        },
        [userToken],
      );
      for (const p of r.data ?? [])
        pages.push({
          id: p.id,
          name: p.name,
          accessToken: p.access_token,
          tasks: p.tasks ?? [],
          instagram: p.instagram_business_account
            ? {
                id: p.instagram_business_account.id,
                username: p.instagram_business_account.username ?? null,
              }
            : null,
        });
      after = r.paging?.next ? r.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return pages;
  }

  // ---- webhooks subscription -----------------------------------------------------------------------------------------

  /** Subscribe the app to the Page's message events. Needs pages_messaging and pages_manage_metadata and a MODERATE task. */
  async subscribePage(pageId: string, pageToken: string, fields: readonly string[]): Promise<void> {
    await this.call(
      'POST',
      `${pageId}/subscribed_apps`,
      {
        subscribed_fields: fields.join(','),
        access_token: pageToken,
      },
      [pageToken],
    );
  }

  async unsubscribePage(pageId: string, pageToken: string): Promise<void> {
    await this.call('DELETE', `${pageId}/subscribed_apps`, { access_token: pageToken }, [
      pageToken,
    ]);
  }

  // ---- health --------------------------------------------------------------------------------------------------------

  async debugToken(inputToken: string): Promise<TokenDebug> {
    const r = await this.call<{
      data: { is_valid?: boolean; scopes?: string[]; expires_at?: number; app_id?: string };
    }>(
      'GET',
      'debug_token',
      {
        input_token: inputToken,
        access_token: `${this.cfg.appId}|${this.cfg.appSecret}`,
      },
      [inputToken],
    );
    const d = r.data ?? {};
    return {
      isValid: d.is_valid === true,
      scopes: Array.isArray(d.scopes) ? d.scopes : null,
      // Meta reports 0 for "never expires"
      expiresAt: d.expires_at ? d.expires_at * 1000 : null,
      appId: d.app_id ?? null,
    };
  }
}
