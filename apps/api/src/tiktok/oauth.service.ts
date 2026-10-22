import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  TikTokApiError,
  hashState,
  safeEqual,
  signState,
  syncTikTokConnection,
  tiktokSecretScope,
  verifyState,
  type TikTokGrant,
  type TikTokMetrics,
  type TikTokShopInfo,
} from '@orderloop/automation';
import { tiktokOrderSink } from '@orderloop/catalog';
import type {
  ConnectTikTokShopsBody,
  ConnectTikTokShopsResult,
  TikTokConnection,
  TikTokOauthSession,
  TikTokOauthStartResult,
} from '@orderloop/contracts';
import { Database, isUniqueViolation, Prisma, type Tx } from '@orderloop/db';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { CredentialVault } from '../couriers/credential-vault.js';
import { REDIS } from '../redis/redis.module.js';
import { toTikTokConnection } from './connections.service.js';
import { TIKTOK_METRICS, toLogFn } from './tiktok.providers.js';
import { TikTokRuntime, tiktokProblem } from './tiktok.runtime.js';

export const TIKTOK_STATE_TTL_MS = 10 * 60_000;
/** How long the one-time link `oauth/start` returns can be used to begin the sign-in. */
export const TIKTOK_TICKET_TTL_MS = 60_000;
/** The cookie that ties the sign-in to the browser that began it. Scoped to the OAuth routes of the API origin. */
export const TIKTOK_OAUTH_COOKIE = 'ol_tiktok_oauth';
export const TIKTOK_OAUTH_COOKIE_PATH = '/v1/integrations/tiktok-shop/oauth';
const TICKET_PREFIX = 'tiktok:oauth:ticket:';

/** The slice of Redis the tickets need (small enough to fake). `getdel` makes redeeming atomic: a ticket works once. */
export interface TikTokTicketStore {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

const sha256hex = (v: string) => createHmac('sha256', 'oauth-ticket').update(v).digest('hex');

/** Where the callback sends the person: the web app's TikTok screen, with a session id or an error code, never a token. */
export const TIKTOK_RETURN_PATH = '/settings/integrations/tiktok-shop';

interface SessionShop {
  id: string;
  name: string;
  region: string | null;
  sellerType: string | null;
}

/** What is sealed in the sign-in hand-over until the shops are chosen: the token pair, as plain JSON. */
interface SealedGrant {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  scopes: string[];
  obtainedAt: string;
}

/** TikTok may ask for a refresh token expiry later than a grant exists; the days a first backfill reads. */
const BACKFILL_DAYS = 7;
const WEBHOOK_EVENT = 'ORDER_STATUS_CHANGE';

@Injectable()
export class TikTokOauthService {
  private readonly log = new Logger('TikTokOAuth');

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly runtime: TikTokRuntime,
    private readonly vault: CredentialVault,
    @Inject(REDIS) private readonly tickets: TikTokTicketStore,
    @Inject(TIKTOK_METRICS) private readonly metrics: TikTokMetrics,
  ) {}

  private requireLive() {
    if (this.runtime.mode !== 'live')
      throw new ApiError(
        'tiktok_not_configured',
        'This server runs the TikTok Shop integration in mock mode: use the mock shop instead of signing in with TikTok.',
      );
    return this.runtime.tiktok();
  }

  private back(params: Record<string, string>): string {
    return `${this.runtime.webAppUrl}${TIKTOK_RETURN_PATH}?${new URLSearchParams(params).toString()}`;
  }

  /**
   * What the browser must present at the callback: an HMAC (keyed with the app secret) of the state's nonce. Nobody who only
   * saw the state, such as someone who was forwarded TikTok's authorize URL, can compute it.
   */
  private cookieValue(nonce: string): string {
    return createHmac('sha256', this.runtime.appSecret!)
      .update(`oauth-cookie.${nonce}`)
      .digest('base64url');
  }

  // ---- 1. start -------------------------------------------------------------------------------------------------------

  async start(auth: AuthContext, reconnectConnectionId?: string): Promise<TikTokOauthStartResult> {
    this.requireLive();
    const now = this.runtime.now().getTime();
    const state = signState(
      {
        t: auth.tenantId,
        u: auth.userId,
        n: randomBytes(16).toString('hex'),
        exp: now + TIKTOK_STATE_TTL_MS,
      },
      this.runtime.appSecret!,
    );
    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      if (reconnectConnectionId) {
        const c = await tx.tikTokConnection.findFirst({
          where: { id: reconnectConnectionId, tenantId: auth.tenantId },
          select: { mock: true },
        });
        if (!c) throw ApiError.notFound('Connection not found');
        if (c.mock)
          throw new ApiError('tiktok_not_configured', 'A mock shop has nothing to reconnect.');
      }
      await tx.tikTokOauthSession.create({
        data: {
          tenantId: auth.tenantId,
          userId: auth.userId,
          stateHash: hashState(state),
          reconnectConnectionId: reconnectConnectionId ?? null,
          expiresAt: new Date(now + TIKTOK_STATE_TTL_MS),
        },
      });
    });
    // Not TikTok's URL itself: a one-time link to OUR `begin` route, which sets the browser-binding cookie and then redirects.
    // The ticket is stored only as a hash, works once, and for 60 seconds.
    const ticket = randomBytes(24).toString('base64url');
    try {
      await this.tickets.set(
        TICKET_PREFIX + sha256hex(ticket),
        JSON.stringify({ state, exp: now + TIKTOK_TICKET_TTL_MS }),
        'EX',
        Math.ceil(TIKTOK_TICKET_TTL_MS / 1000),
      );
    } catch {
      throw new ApiError(
        'tiktok_unavailable',
        'TikTok sign-in is unavailable right now. Try again shortly.',
      );
    }
    return {
      mode: 'live',
      authorizeUrl: `${this.runtime.beginUrl}?${new URLSearchParams({ ticket }).toString()}`,
    };
  }

  // ---- 1b. begin (public: the person's browser navigates here, top level) ----------------------------------------------

  /**
   * Redeems the ticket and answers where to send the browser (TikTok's authorize page) and which cookie to set. The cookie binds
   * the sign-in to THIS browser, so that a URL forwarded to somebody else cannot be completed in their browser (login CSRF), with
   * no third-party cookies involved (it is set by the API on its own origin, in a top-level navigation).
   */
  async begin(
    ticket: string | undefined,
  ): Promise<{ redirect: string; cookie?: { value: string; maxAgeMs: number } }> {
    if (this.runtime.mode !== 'live' || !this.runtime.liveConfigured)
      return { redirect: this.back({ error: 'tiktok_not_configured' }) };
    const invalid = { redirect: this.back({ error: 'invalid_state' }) };
    if (!ticket) return invalid;
    let stored: string | null = null;
    try {
      stored = await this.tickets.getdel(TICKET_PREFIX + sha256hex(ticket));
    } catch {
      return { redirect: this.back({ error: 'tiktok_unavailable' }) };
    }
    if (!stored) return invalid;
    const now = this.runtime.now().getTime();
    let state: string;
    try {
      const v = JSON.parse(stored) as { state?: unknown; exp?: unknown };
      if (typeof v.state !== 'string' || typeof v.exp !== 'number' || v.exp <= now) return invalid;
      state = v.state;
    } catch {
      return invalid;
    }
    const claims = verifyState(state, this.runtime.appSecret!, now);
    if (!claims) return invalid;
    return {
      redirect: this.runtime.tiktok().authorizeUrl(state),
      cookie: { value: this.cookieValue(claims.n), maxAgeMs: Math.max(1000, claims.exp - now) },
    };
  }

  // ---- 2. callback (public: TikTok sends the person's browser here) ---------------------------------------------------------

  /** Always answers with a redirect URL: success carries `session`, everything else `error` (a short code, no detail). */
  async callback(
    query: { code?: string | undefined; state?: string | undefined; error?: string | undefined },
    cookie?: string | undefined,
  ): Promise<string> {
    if (this.runtime.mode !== 'live' || !this.runtime.liveConfigured)
      return this.back({ error: 'tiktok_not_configured' });
    const now = this.runtime.now().getTime();
    const claims = query.state ? verifyState(query.state, this.runtime.appSecret!, now) : null;
    if (!claims || !query.state) return this.back({ error: 'invalid_state' });
    // The browser must be the one that began this sign-in. Checked before the state is claimed, so a stranger who was
    // forwarded the URL cannot use up (or progress) somebody else's sign-in.
    if (!cookie || !safeEqual(cookie, this.cookieValue(claims.n)))
      return this.back({ error: 'invalid_state' });
    const stateHash = hashState(query.state);

    // Single use: claim the state BEFORE doing anything with the code, so a replay can never get further.
    const session = await this.db.withContext(
      { tenantId: claims.t, userId: claims.u },
      async (tx) => {
        const claimed = await tx.tikTokOauthSession.updateMany({
          where: {
            tenantId: claims.t,
            userId: claims.u,
            stateHash,
            stateUsedAt: null,
            expiresAt: { gt: new Date(now) },
          },
          data: { stateUsedAt: new Date(now) },
        });
        if (claimed.count !== 1) return null;
        return tx.tikTokOauthSession.findFirst({ where: { tenantId: claims.t, stateHash } });
      },
    );
    if (!session) return this.back({ error: 'invalid_state' });

    // The seller said no (or TikTok refused): nothing to exchange.
    if (query.error || !query.code) return this.back({ error: 'access_denied' });

    const client = this.runtime.tiktok();
    try {
      const grant = await client.exchangeCode(query.code);
      const shops = await client.getAuthorizedShops(grant.accessToken);
      await this.db.withContext({ tenantId: claims.t, userId: claims.u }, (tx) =>
        tx.tikTokOauthSession.update({
          where: { id: session.id },
          data: {
            grantEnc: this.vault.encryptJson(
              {
                accessToken: grant.accessToken,
                refreshToken: grant.refreshToken,
                accessExpiresAt: grant.accessExpiresAt?.toISOString() ?? null,
                refreshExpiresAt: grant.refreshExpiresAt?.toISOString() ?? null,
                scopes: grant.scopes,
                obtainedAt: this.runtime.now().toISOString(),
              } satisfies SealedGrant,
              tiktokSecretScope(claims.t, 'grant'),
            ),
            shops: shops.map(toSessionShop) as unknown as Prisma.InputJsonValue,
          },
        }),
      );
      return this.back({ session: session.id });
    } catch (error) {
      const problem = tiktokProblem(error);
      this.log.warn(`TikTok sign-in could not be completed: ${problem.code}`);
      return this.back({ error: oauthErrorCode(problem.code) });
    }
  }

  // ---- 3. choose --------------------------------------------------------------------------------------------------------

  /** The session if it is this person's, finished by the callback, not expired and not already used. */
  private async liveSession(tx: Tx, auth: AuthContext, id: string) {
    const s = await tx.tikTokOauthSession.findFirst({
      where: { id, tenantId: auth.tenantId, userId: auth.userId },
    });
    if (!s || !s.stateUsedAt || !s.grantEnc || s.consumedAt || s.expiresAt <= this.runtime.now())
      throw new ApiError(
        'tiktok_oauth_invalid',
        'This sign-in has expired or was already used. Start again.',
      );
    return s;
  }

  async session(auth: AuthContext, id: string): Promise<TikTokOauthSession> {
    const s = await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      this.liveSession(tx, auth, id),
    );
    const shops = (s.shops as unknown as SessionShop[]) ?? [];
    const target = s.reconnectConnectionId
      ? await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
          tx.tikTokConnection.findFirst({
            where: { id: s.reconnectConnectionId!, tenantId: auth.tenantId },
          }),
        )
      : null;
    const out: TikTokOauthSession['shops'] = [];
    for (const shop of shops) {
      const taken = await this.db.tiktokConnectionFor(shop.id);
      const held = taken !== null && taken.status !== 'disconnected';
      // Reconnecting a shop that is already ours is the point, not a conflict.
      const mine = held && taken.tenantId === auth.tenantId && target?.shopId === shop.id;
      out.push({
        id: shop.id,
        name: shop.name,
        region: shop.region,
        sellerType: shop.sellerType,
        alreadyConnected: held && !mine,
      });
    }
    return {
      mode: this.runtime.mode,
      id: s.id,
      expiresAt: s.expiresAt.toISOString(),
      shops: out,
      reconnectConnectionId: s.reconnectConnectionId,
    };
  }

  // ---- 4. connect ---------------------------------------------------------------------------------------------------------

  async connect(
    auth: AuthContext,
    body: ConnectTikTokShopsBody,
    ip: string | null,
  ): Promise<ConnectTikTokShopsResult> {
    const client = this.requireLive();
    const s = await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      this.liveSession(tx, auth, body.sessionId),
    );
    const offered = new Map(((s.shops as unknown as SessionShop[]) ?? []).map((x) => [x.id, x]));
    const shopIds = [...new Set(body.shopIds)];
    shopIds.forEach((id, i) => {
      if (!offered.has(id))
        throw new ApiError('validation_failed', 'Request validation failed', [
          { path: `body.shopIds.${i}`, message: 'That shop was not offered in this sign-in' },
        ]);
    });
    let target: { shopId: string } | null = null;
    if (s.reconnectConnectionId) {
      target = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
        tx.tikTokConnection.findFirst({
          where: { id: s.reconnectConnectionId!, tenantId: auth.tenantId },
          select: { shopId: true },
        }),
      );
      if (!target || shopIds.some((id) => id !== target!.shopId))
        throw new ApiError('validation_failed', 'Request validation failed', [
          { path: 'body.shopIds', message: 'This sign-in is for reconnecting one specific shop' },
        ]);
    }

    // The ciphers come from TikTok again now (they are not kept in the session).
    const sealed = this.vault.decryptJson<SealedGrant>(
      s.grantEnc!,
      tiktokSecretScope(auth.tenantId, 'grant'),
    );
    let fresh: TikTokShopInfo[];
    try {
      fresh = await client.getAuthorizedShops(sealed.accessToken);
    } catch (error) {
      throw tiktokProblem(error);
    }
    const byId = new Map(fresh.map((x) => [x.id, x]));
    const grantId = randomUUID();
    const now = this.runtime.now();
    const grant: TikTokGrant = {
      accessToken: sealed.accessToken,
      refreshToken: sealed.refreshToken,
      accessExpiresAt: sealed.accessExpiresAt ? new Date(sealed.accessExpiresAt) : null,
      refreshExpiresAt: sealed.refreshExpiresAt ? new Date(sealed.refreshExpiresAt) : null,
      scopes: sealed.scopes,
    };

    const connections: TikTokConnection[] = [];
    const failures: ConnectTikTokShopsResult['failures'] = [];
    for (const shopId of shopIds) {
      const shop = byId.get(shopId);
      const fail = (e: ApiError) =>
        failures.push({ shopId, code: e.code, message: e.detail ?? e.code });
      if (!shop) {
        fail(
          new ApiError(
            'tiktok_permission_denied',
            'TikTok no longer lists this shop for you. Authorise it again.',
          ),
        );
        continue;
      }
      const owner = await this.db.tiktokConnectionFor(shopId);
      if (owner && owner.status !== 'disconnected' && owner.tenantId !== auth.tenantId) {
        fail(ApiError.conflict('This shop is already connected to another business.'));
        continue;
      }
      try {
        const saved = await this.db.withContext(
          { tenantId: auth.tenantId, userId: auth.userId },
          async (tx) => {
            const data = {
              grantId,
              shopCipher: shop.cipher,
              shopName: shop.name,
              region: shop.region,
              sellerType: shop.sellerType,
              status: 'active' as const,
              accessTokenEnc: this.vault.encrypt(
                grant.accessToken,
                tiktokSecretScope(auth.tenantId, 'access'),
              ),
              refreshTokenEnc: grant.refreshToken
                ? this.vault.encrypt(
                    grant.refreshToken,
                    tiktokSecretScope(auth.tenantId, 'refresh'),
                  )
                : null,
              tokensObtainedAt: now,
              accessExpiresAt: grant.accessExpiresAt,
              refreshExpiresAt: grant.refreshExpiresAt,
              refreshFailures: 0,
              nextRefreshAt: null,
              scopes: grant.scopes as unknown as Prisma.InputJsonValue,
              lastErrorCode: null,
              lastErrorMessage: null,
              disconnectedAt: null,
              connectedById: auth.userId,
            };
            // Connecting a shop this business had (even one it disconnected) revives that connection: its orders and links stay.
            const existing = await tx.tikTokConnection.findFirst({
              where: { tenantId: auth.tenantId, shopId, mock: false },
              orderBy: [{ createdAt: 'desc' }],
            });
            const row = existing
              ? await tx.tikTokConnection.update({
                  where: { id: existing.id, tenantId: auth.tenantId },
                  data,
                })
              : await tx.tikTokConnection.create({
                  data: { ...data, tenantId: auth.tenantId, shopId, mock: false },
                });
            await this.audit.record(tx, {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: existing ? 'integration.tiktok_reconnected' : 'integration.tiktok_connected',
              targetType: 'tiktok_connection',
              targetId: row.id,
              metadata: { region: shop.region },
              ip,
            });
            return row;
          },
        );
        connections.push(toTikTokConnection(saved));
      } catch (error) {
        if (isUniqueViolation(error))
          fail(ApiError.conflict('This shop was just connected to another business.'));
        else throw error;
      }
    }
    if (connections.length === 0 && failures[0])
      throw new ApiError(failures[0].code as 'conflict', failures[0].message);

    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      tx.tikTokOauthSession.updateMany({
        where: { id: s.id, tenantId: auth.tenantId, consumedAt: null },
        // the sealed token pair is not needed any more
        data: { consumedAt: this.runtime.now(), grantEnc: null },
      }),
    );

    // Best effort after the connection exists: subscribe the order webhook (otherwise it is set once in Partner Center: the
    // docs say how) and read the last week of orders. A failure here never undoes the connection: the scheduled check retries.
    const authDeps = this.runtime.authDeps(this.db, this.vault, toLogFn(this.log), this.metrics);
    for (const c of connections) {
      const shop = byId.get(c.shopId)!;
      try {
        await client.updateWebhook(
          { accessToken: grant.accessToken, shopCipher: shop.cipher },
          WEBHOOK_EVENT,
          this.runtime.webhookUrl,
        );
      } catch (error) {
        this.log.warn(
          `Could not subscribe the TikTok order webhook (${tiktokProblem(error).code}): set it in Partner Center instead`,
        );
      }
      try {
        await syncTikTokConnection(
          { ...authDeps, sink: tiktokOrderSink },
          { tenantId: auth.tenantId, connectionId: c.id },
          { since: new Date(now.getTime() - BACKFILL_DAYS * 86_400_000) },
        );
      } catch (error) {
        this.log.warn(
          `The first read of orders failed (${error instanceof TikTokApiError ? error.kind : 'error'}); the scheduled check will retry`,
        );
      }
    }
    return { mode: this.runtime.mode, connections, failures };
  }
}

function toSessionShop(s: TikTokShopInfo): SessionShop {
  return { id: s.id, name: s.name, region: s.region, sellerType: s.sellerType };
}

/** The sign-in redirect's error vocabulary (docs/tiktok-shop.md): a short fixed set, nothing from TikTok. */
function oauthErrorCode(code: string): string {
  switch (code) {
    case 'tiktok_token_invalid':
    case 'tiktok_permission_denied':
    case 'tiktok_not_configured':
    case 'rate_limited':
      return code;
    default:
      return 'tiktok_unavailable';
  }
}
