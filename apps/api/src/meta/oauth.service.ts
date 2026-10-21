import { createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  hashState,
  safeEqual,
  signState,
  verifyState,
  type GraphPage,
} from '@orderloop/automation';
import type {
  ConnectPagesBody,
  ConnectPagesResult,
  OauthSession,
  OauthStartResult,
  SocialConnection,
} from '@orderloop/contracts';
import { Database, isUniqueViolation, Prisma, type Tx } from '@orderloop/db';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { CredentialVault } from '../couriers/credential-vault.js';
import { REDIS } from '../redis/redis.module.js';
import { toConnection } from './connections.service.js';
import { graphProblem, MetaRuntime } from './meta.runtime.js';

export const STATE_TTL_MS = 10 * 60_000;
/** How long the one-time link `oauth/start` returns can be used to begin the sign-in. */
export const TICKET_TTL_MS = 60_000;
/** The cookie that ties the sign-in to the browser that began it. Scoped to the OAuth routes of the API origin. */
export const OAUTH_COOKIE = 'ol_meta_oauth';
export const OAUTH_COOKIE_PATH = '/v1/integrations/meta/oauth';
const TICKET_PREFIX = 'meta:oauth:ticket:';

/** The slice of Redis the tickets need (small enough to fake). `getdel` makes redeeming atomic: a ticket works once. */
export interface TicketStore {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

const sha256hex = (v: string) => createHmac('sha256', 'oauth-ticket').update(v).digest('hex');

/** Only these two: messages and the Page's own postbacks. Nothing about posts, comments or the Page's content. */
const SUBSCRIBED_FIELDS = ['messages', 'messaging_postbacks'] as const;

interface SessionPage {
  id: string;
  name: string;
  instagram: { id: string; username: string | null } | null;
}

/** Where the callback sends the person: the web app's integrations screen, with a session id or an error code, never a token. */
export const RETURN_PATH = '/settings/integrations/meta';

@Injectable()
export class OauthService {
  private readonly log = new Logger('MetaOAuth');

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly runtime: MetaRuntime,
    private readonly vault: CredentialVault,
    @Inject(REDIS) private readonly tickets: TicketStore,
  ) {}

  private requireLive() {
    if (this.runtime.mode !== 'live')
      throw new ApiError(
        'meta_not_configured',
        'This server runs the Meta integration in mock mode: use the mock connection instead of signing in with Meta.',
      );
    return this.runtime.graph();
  }

  private back(params: Record<string, string>): string {
    return `${this.runtime.webAppUrl}${RETURN_PATH}?${new URLSearchParams(params).toString()}`;
  }

  /**
   * What the browser must present at the callback: an HMAC (keyed with the app secret) of the state's nonce. Nobody who only
   * saw the state, such as someone who was forwarded Meta's dialog URL, can compute it.
   */
  private cookieValue(nonce: string): string {
    return createHmac('sha256', this.runtime.appSecret!)
      .update(`oauth-cookie.${nonce}`)
      .digest('base64url');
  }

  // ---- 1. start -------------------------------------------------------------------------------------------------------

  async start(auth: AuthContext, reconnectConnectionId?: string): Promise<OauthStartResult> {
    this.requireLive();
    const now = this.runtime.now().getTime();
    const state = signState(
      {
        t: auth.tenantId,
        u: auth.userId,
        n: randomBytes(16).toString('hex'),
        exp: now + STATE_TTL_MS,
      },
      this.runtime.appSecret!,
    );
    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      if (reconnectConnectionId) {
        const c = await tx.socialConnection.findFirst({
          where: { id: reconnectConnectionId, tenantId: auth.tenantId },
          select: { mock: true },
        });
        if (!c) throw ApiError.notFound('Connection not found');
        if (c.mock)
          throw new ApiError('meta_not_configured', 'A mock connection has nothing to reconnect.');
      }
      await tx.socialOauthSession.create({
        data: {
          tenantId: auth.tenantId,
          userId: auth.userId,
          stateHash: hashState(state),
          reconnectConnectionId: reconnectConnectionId ?? null,
          expiresAt: new Date(now + STATE_TTL_MS),
        },
      });
    });
    // Not Meta's URL itself: a one-time link to OUR `begin` route, which sets the browser-binding cookie and then redirects.
    // The ticket is stored only as a hash, works once, and for 60 seconds.
    const ticket = randomBytes(24).toString('base64url');
    try {
      await this.tickets.set(
        TICKET_PREFIX + sha256hex(ticket),
        JSON.stringify({ state, exp: now + TICKET_TTL_MS }),
        'EX',
        Math.ceil(TICKET_TTL_MS / 1000),
      );
    } catch {
      throw new ApiError(
        'meta_unavailable',
        'Meta sign-in is unavailable right now. Try again shortly.',
      );
    }
    return {
      mode: 'live',
      authorizeUrl: `${this.runtime.beginUrl}?${new URLSearchParams({ ticket }).toString()}`,
    };
  }

  // ---- 1b. begin (public: the person's browser navigates here, top level) --------------------------------------------------

  /**
   * Redeems the ticket and answers where to send the browser (Meta's dialog) and which cookie to set. The cookie binds the
   * sign-in to THIS browser, so that a URL forwarded to somebody else cannot be completed in their browser (login CSRF), with
   * no third-party cookies involved (it is set by the API on its own origin, in a top-level navigation).
   */
  async begin(
    ticket: string | undefined,
  ): Promise<{ redirect: string; cookie?: { value: string; maxAgeMs: number } }> {
    if (this.runtime.mode !== 'live' || !this.runtime.liveConfigured)
      return { redirect: this.back({ error: 'meta_not_configured' }) };
    const invalid = { redirect: this.back({ error: 'invalid_state' }) };
    if (!ticket) return invalid;
    let stored: string | null = null;
    try {
      stored = await this.tickets.getdel(TICKET_PREFIX + sha256hex(ticket));
    } catch {
      return { redirect: this.back({ error: 'meta_unavailable' }) };
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
      redirect: this.runtime.graph().authorizeUrl({
        redirectUri: this.runtime.redirectUri,
        state,
        scopes: this.runtime.scopes,
      }),
      cookie: { value: this.cookieValue(claims.n), maxAgeMs: Math.max(1000, claims.exp - now) },
    };
  }

  // ---- 2. callback (public: Meta sends the person's browser here) ---------------------------------------------------------

  /** Always answers with a redirect URL: success carries `session`, everything else `error` (a short code, no detail). */
  async callback(
    query: {
      code?: string | undefined;
      state?: string | undefined;
      error?: string | undefined;
    },
    cookie?: string | undefined,
  ): Promise<string> {
    if (this.runtime.mode !== 'live' || !this.runtime.liveConfigured)
      return this.back({ error: 'meta_not_configured' });
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
        const claimed = await tx.socialOauthSession.updateMany({
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
        return tx.socialOauthSession.findFirst({ where: { tenantId: claims.t, stateHash } });
      },
    );
    if (!session) return this.back({ error: 'invalid_state' });

    // The person said no (or Meta refused): nothing to exchange.
    if (query.error || !query.code) return this.back({ error: 'access_denied' });

    const graph = this.runtime.graph();
    try {
      const short = await graph.exchangeCode(query.code, this.runtime.redirectUri);
      const long = await graph.exchangeLongLived(short);
      const [me, pages] = await Promise.all([graph.me(long.token), graph.listPages(long.token)]);
      await this.db.withContext({ tenantId: claims.t, userId: claims.u }, (tx) =>
        tx.socialOauthSession.update({
          where: { id: session.id },
          data: {
            userTokenEnc: this.vault.encrypt(long.token, {
              tenantId: claims.t,
              provider: 'meta_user',
            }),
            metaUserId: me.id,
            pages: pages.map(toSessionPage) as unknown as Prisma.InputJsonValue,
          },
        }),
      );
      return this.back({ session: session.id });
    } catch (error) {
      const problem = graphProblem(error);
      this.log.warn(`Meta sign-in could not be completed: ${problem.code}`);
      return this.back({ error: problem.code });
    }
  }

  // ---- 3. choose --------------------------------------------------------------------------------------------------------

  /** The session if it is this person's, finished by the callback, not expired and not already used. */
  private async liveSession(tx: Tx, auth: AuthContext, id: string) {
    const s = await tx.socialOauthSession.findFirst({
      where: { id, tenantId: auth.tenantId, userId: auth.userId },
    });
    if (
      !s ||
      !s.stateUsedAt ||
      !s.userTokenEnc ||
      s.consumedAt ||
      s.expiresAt <= this.runtime.now()
    )
      throw new ApiError(
        'meta_oauth_invalid',
        'This sign-in has expired or was already used. Start again.',
      );
    return s;
  }

  async session(auth: AuthContext, id: string): Promise<OauthSession> {
    const s = await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      this.liveSession(tx, auth, id),
    );
    const pages = (s.pages as unknown as SessionPage[]) ?? [];
    const target = s.reconnectConnectionId
      ? await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
          tx.socialConnection.findFirst({
            where: { id: s.reconnectConnectionId!, tenantId: auth.tenantId },
          }),
        )
      : null;
    const out: OauthSession['pages'] = [];
    for (const p of pages) {
      const taken = await this.db.metaConnectionFor('facebook_page', p.id);
      // Reconnecting an account that is already ours is the point, not a conflict.
      const mine = taken?.tenantId === auth.tenantId && target !== null;
      out.push({
        id: p.id,
        name: p.name,
        instagram: p.instagram,
        alreadyConnected: Boolean(taken) && !mine,
      });
    }
    return {
      mode: this.runtime.mode,
      id: s.id,
      expiresAt: s.expiresAt.toISOString(),
      pages: out,
      reconnectConnectionId: s.reconnectConnectionId,
    };
  }

  // ---- 4. connect ---------------------------------------------------------------------------------------------------------

  async connect(
    auth: AuthContext,
    body: ConnectPagesBody,
    ip: string | null,
  ): Promise<ConnectPagesResult> {
    const graph = this.requireLive();
    const s = await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      this.liveSession(tx, auth, body.sessionId),
    );
    const known = new Map(((s.pages as unknown as SessionPage[]) ?? []).map((p) => [p.id, p]));
    const pageIds = [...new Set(body.pageIds)];
    pageIds.forEach((id, i) => {
      if (!known.has(id))
        throw new ApiError('validation_failed', 'Request validation failed', [
          { path: `body.pageIds.${i}`, message: 'That Page was not offered in this sign-in' },
        ]);
    });
    if (s.reconnectConnectionId) {
      const target = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
        tx.socialConnection.findFirst({
          where: { id: s.reconnectConnectionId!, tenantId: auth.tenantId },
        }),
      );
      const pageOfTarget =
        target?.provider === 'instagram' ? target.linkedPageId : target?.externalId;
      if (!pageOfTarget || pageIds.some((id) => id !== pageOfTarget))
        throw new ApiError('validation_failed', 'Request validation failed', [
          {
            path: 'body.pageIds',
            message: 'This sign-in is for reconnecting one specific account',
          },
        ]);
    }

    // The Page tokens come from Meta again now (they are not kept in the session).
    const userToken = this.vault.decrypt(s.userTokenEnc!, {
      tenantId: auth.tenantId,
      provider: 'meta_user',
    });
    let fresh: GraphPage[];
    try {
      fresh = await graph.listPages(userToken);
    } catch (error) {
      throw graphProblem(error);
    }
    const tokens = new Map(fresh.map((p) => [p.id, p]));

    const connections: SocialConnection[] = [];
    const failures: ConnectPagesResult['failures'] = [];
    for (const pageId of pageIds) {
      const page = tokens.get(pageId);
      const fail = (e: ApiError) =>
        failures.push({ pageId, code: e.code, message: e.detail ?? e.code });
      if (!page) {
        fail(
          new ApiError(
            'meta_permission_denied',
            'Meta no longer lists this Page for you. Approve it and sign in again.',
          ),
        );
        continue;
      }
      const owner = await this.db.metaConnectionFor('facebook_page', page.id);
      if (owner && owner.tenantId !== auth.tenantId) {
        fail(ApiError.conflict('This Page is already connected to another business.'));
        continue;
      }
      if (page.instagram) {
        const igOwner = await this.db.metaConnectionFor('instagram', page.instagram.id);
        if (igOwner && igOwner.tenantId !== auth.tenantId) {
          fail(
            ApiError.conflict(
              'The Instagram account linked to this Page is already connected to another business.',
            ),
          );
          continue;
        }
      }
      if (s.reconnectConnectionId && !page.instagram) {
        const target = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
          tx.socialConnection.findFirst({
            where: { id: s.reconnectConnectionId!, tenantId: auth.tenantId },
          }),
        );
        if (target?.provider === 'instagram') {
          fail(
            new ApiError(
              'meta_instagram_not_linked',
              'This Page has no Instagram professional account linked any more.',
            ),
          );
          continue;
        }
      }
      try {
        await graph.subscribePage(page.id, page.accessToken, SUBSCRIBED_FIELDS);
      } catch (error) {
        fail(graphProblem(error));
        continue;
      }
      // Scopes and expiry are informative only: failing to read them must not stop the connection.
      let scopes: string[] = [];
      let expiresAt: Date | null = null;
      try {
        const debug = await graph.debugToken(page.accessToken);
        scopes = debug.scopes ?? [];
        expiresAt = debug.expiresAt ? new Date(debug.expiresAt) : null;
      } catch {
        /* informative only */
      }
      try {
        const saved = await this.db.withContext(
          { tenantId: auth.tenantId, userId: auth.userId },
          async (tx) => {
            const rows: SocialConnection[] = [];
            const accounts = [
              {
                provider: 'facebook_page' as const,
                externalId: page.id,
                displayName: page.name,
                username: null,
                linkedPageId: null,
              },
              ...(page.instagram
                ? [
                    {
                      provider: 'instagram' as const,
                      externalId: page.instagram.id,
                      displayName: page.instagram.username
                        ? `@${page.instagram.username}`
                        : page.name,
                      username: page.instagram.username,
                      linkedPageId: page.id,
                    },
                  ]
                : []),
            ];
            for (const a of accounts) {
              const data = {
                displayName: a.displayName,
                username: a.username,
                linkedPageId: a.linkedPageId,
                status: 'active' as const,
                accessTokenEnc: this.vault.encrypt(page.accessToken, {
                  tenantId: auth.tenantId,
                  provider: `meta_${a.provider}`,
                }),
                tokenType: 'page',
                tokenExpiresAt: expiresAt,
                scopes: scopes as unknown as Prisma.InputJsonValue,
                metaUserId: s.metaUserId,
                lastErrorCode: null,
                lastErrorMessage: null,
                disconnectedAt: null,
                connectedById: auth.userId,
              };
              const existing = await tx.socialConnection.findFirst({
                where: {
                  tenantId: auth.tenantId,
                  provider: a.provider,
                  externalId: a.externalId,
                  status: { not: 'disconnected' },
                },
              });
              const row = existing
                ? await tx.socialConnection.update({
                    where: { id: existing.id, tenantId: auth.tenantId },
                    data,
                  })
                : await tx.socialConnection.create({
                    data: {
                      ...data,
                      tenantId: auth.tenantId,
                      provider: a.provider,
                      externalId: a.externalId,
                      mock: false,
                    },
                  });
              await this.audit.record(tx, {
                tenantId: auth.tenantId,
                actorUserId: auth.userId,
                action: existing ? 'integration.reconnected' : 'integration.connected',
                targetType: 'social_connection',
                targetId: row.id,
                metadata: { provider: a.provider },
                ip,
              });
              rows.push(toConnection(row));
            }
            return rows;
          },
        );
        connections.push(...saved);
      } catch (error) {
        if (isUniqueViolation(error))
          fail(ApiError.conflict('This account was just connected to another business.'));
        else throw error;
      }
    }
    if (connections.length === 0 && failures[0])
      throw new ApiError(failures[0].code as 'conflict', failures[0].message);
    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      tx.socialOauthSession.updateMany({
        where: { id: s.id, tenantId: auth.tenantId, consumedAt: null },
        // the sealed user token is not needed any more
        data: { consumedAt: this.runtime.now(), userTokenEnc: null },
      }),
    );
    return { mode: this.runtime.mode, connections, failures };
  }
}

function toSessionPage(p: GraphPage): SessionPage {
  return { id: p.id, name: p.name, instagram: p.instagram };
}
