import type { Database } from '@orderloop/db';
import { tikTokRefreshBackoffMs, tikTokRefreshDue } from '@orderloop/domain';
import type { Logger } from '../jobs.js';
import type { SecretBox } from '../secret-box.js';
import { TikTokApiError, type ShopContext, type TikTokShopClient } from './client.js';
import { noopTikTokMetrics, type TikTokMetrics, type TikTokRefreshOutcome } from './metrics.js';

export interface TikTokAuthDeps {
  db: Database;
  client: TikTokShopClient;
  vault: SecretBox;
  log: Logger;
  now: () => Date;
  metrics?: TikTokMetrics;
}

/** The authenticated-data scopes the sealed values are bound to (so a copied value cannot be opened in another business or slot). */
export const tiktokSecretScope = (
  tenantId: string,
  kind: 'access' | 'refresh' | 'grant',
): { tenantId: string; provider: string } => ({ tenantId, provider: `tiktok_${kind}` });

/** What to tell a person, with no token or TikTok text in it. */
export const TIKTOK_PROBLEMS = {
  token_invalid: {
    status: 'needs_reconnect' as const,
    code: 'token_invalid',
    message: 'TikTok no longer accepts the saved access. Reconnect this shop.',
  },
  permission: {
    status: 'permission_error' as const,
    code: 'permission_denied',
    message:
      'A permission this shop needs was removed or is missing. Reconnect and approve all permissions.',
  },
};

/** Renew within this long of expiry no matter what the maths says: a call must not start with a token about to die. */
const EXPIRY_SKEW_MS = 60_000;

export type RefreshOutcome = TikTokRefreshOutcome;

/**
 * Renew one grant's tokens (every shop authorised in one sign-in shares them). One worker at a time per grant: a transaction-level
 * advisory lock is TRIED, never waited for, so a second worker (or the inline renewal of a call that found the token expired)
 * simply skips; the due-check is repeated after the lock, so a worker that arrives just after another finished sees fresh
 * tokens and does nothing. The new pair (both tokens: a refresh token may be single use) is written for every shop of the grant
 * in the same transaction, together with their expiry. On failure the old tokens stay: an invalid or expired refresh token marks the
 * shops `needs_reconnect`, a permission error `permission_error`, a rate limit or outage backs the next attempt off (15 minutes,
 * doubling, at most 6 hours). A token never appears in a log line.
 */
export async function refreshTikTokTokens(
  deps: TikTokAuthDeps,
  ref: { tenantId: string; connectionId: string },
  opts: { force?: boolean } = {},
): Promise<RefreshOutcome> {
  const { tenantId, connectionId } = ref;
  const metrics = deps.metrics ?? noopTikTokMetrics;
  const outcome = await deps.db.withContext(
    { tenantId },
    async (tx): Promise<RefreshOutcome> => {
      const peek = await tx.tikTokConnection.findFirst({ where: { id: connectionId, tenantId } });
      if (!peek || peek.mock || !peek.refreshTokenEnc) return 'skipped';
      const lock = await tx.$queryRaw<
        { ok: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`tiktok-refresh|${peek.grantId}`}, 0)) AS ok`;
      if (!lock[0]?.ok) return 'locked';
      // Re-read under the lock: another worker may have renewed these tokens a moment ago.
      const conn = await tx.tikTokConnection.findFirst({ where: { id: connectionId, tenantId } });
      if (
        !conn ||
        conn.mock ||
        !conn.refreshTokenEnc ||
        !['active', 'permission_error'].includes(conn.status)
      )
        return 'skipped';
      const now = deps.now();
      if (
        !opts.force &&
        !tikTokRefreshDue(now, {
          obtainedAt: conn.tokensObtainedAt,
          accessExpiresAt: conn.accessExpiresAt,
          refreshExpiresAt: conn.refreshExpiresAt,
        })
      )
        return 'skipped';

      const grantRows = { tenantId, grantId: conn.grantId };
      try {
        const old = deps.vault.decrypt(
          conn.refreshTokenEnc,
          tiktokSecretScope(tenantId, 'refresh'),
        );
        const grant = await deps.client.refresh(old);
        const newRefresh = grant.refreshToken || old;
        await tx.tikTokConnection.updateMany({
          where: { ...grantRows, status: { not: 'disconnected' } },
          data: {
            accessTokenEnc: deps.vault.encrypt(
              grant.accessToken,
              tiktokSecretScope(tenantId, 'access'),
            ),
            refreshTokenEnc: deps.vault.encrypt(newRefresh, tiktokSecretScope(tenantId, 'refresh')),
            tokensObtainedAt: now,
            accessExpiresAt: grant.accessExpiresAt,
            // TikTok sometimes omits the refresh expiry on a refresh: keep what we knew rather than forget it.
            ...(grant.refreshExpiresAt ? { refreshExpiresAt: grant.refreshExpiresAt } : {}),
            refreshFailures: 0,
            nextRefreshAt: null,
          },
        });
        return 'refreshed';
      } catch (error) {
        const kind = error instanceof TikTokApiError ? error.kind : null;
        if (kind === 'token_invalid' || kind === 'permission') {
          const p = TIKTOK_PROBLEMS[kind];
          await tx.tikTokConnection.updateMany({
            where: { ...grantRows, status: { not: 'disconnected' } },
            data: {
              status: p.status,
              lastErrorCode: p.code,
              lastErrorMessage: p.message,
              nextRefreshAt: null,
            },
          });
          if (p.status !== conn.status)
            await tx.auditLog.createMany({
              data: [
                {
                  tenantId,
                  actorUserId: null,
                  action: 'integration.needs_attention',
                  targetType: 'tiktok_connection',
                  targetId: connectionId,
                  metadata: { status: p.status, code: p.code, during: 'token_refresh' },
                },
              ],
            });
          return kind === 'token_invalid' ? 'needs_reconnect' : 'permission_error';
        }
        // A rate limit, an outage, a bad request or a value we cannot open: keep everything, try again later.
        const failures = conn.refreshFailures + 1;
        await tx.tikTokConnection.updateMany({
          where: { ...grantRows, status: { not: 'disconnected' } },
          data: {
            refreshFailures: failures,
            nextRefreshAt: new Date(now.getTime() + tikTokRefreshBackoffMs(failures)),
          },
        });
        return 'failed';
      }
    },
    // The call to TikTok happens inside this transaction (it holds the advisory lock): allow for its timeout.
    { timeout: 30_000, maxWait: 10_000 },
  );
  metrics.refresh(outcome);
  if (outcome !== 'skipped' && outcome !== 'locked')
    deps.log({
      level: outcome === 'refreshed' ? 'info' : 'warn',
      event: 'tiktok.token_refresh',
      tenantId,
      connectionId,
      outcome,
    });
  return outcome;
}

/** The connections whose tokens are inside their renewal window, renewed one grant at a time. One failing never stops the rest. */
export async function refreshDueTikTokTokens(
  deps: TikTokAuthDeps,
): Promise<Record<RefreshOutcome, number>> {
  const counts: Record<RefreshOutcome, number> = {
    refreshed: 0,
    skipped: 0,
    locked: 0,
    failed: 0,
    needs_reconnect: 0,
    permission_error: 0,
  };
  const due = await deps.db.tiktokConnectionsDueForRefresh(200);
  for (const c of due) {
    // The scan is a loose pre-filter: the exact window (half the lifetime) is applied here, and again under the lock.
    if (
      !tikTokRefreshDue(deps.now(), {
        obtainedAt: c.tokensObtainedAt,
        accessExpiresAt: c.accessExpiresAt,
        refreshExpiresAt: c.refreshExpiresAt,
      })
    ) {
      counts.skipped++;
      continue;
    }
    try {
      counts[await refreshTikTokTokens(deps, { tenantId: c.tenantId, connectionId: c.id })]++;
    } catch (error) {
      counts.failed++;
      deps.log({
        level: 'error',
        event: 'tiktok.token_refresh_error',
        connectionId: c.id,
        error: (error as Error).name,
      });
    }
  }
  return counts;
}

/** Record that TikTok refused a connection, and say so in the audit trail the first time. Never throws for a missing connection. */
export async function recordTikTokProblem(
  deps: Pick<TikTokAuthDeps, 'db' | 'log'>,
  ref: { tenantId: string; connectionId: string },
  kind: 'token_invalid' | 'permission',
): Promise<void> {
  const p = TIKTOK_PROBLEMS[kind];
  await deps.db.withContext({ tenantId: ref.tenantId }, async (tx) => {
    const conn = await tx.tikTokConnection.findFirst({
      where: { id: ref.connectionId, tenantId: ref.tenantId },
      select: { status: true },
    });
    if (!conn || conn.status === 'disconnected') return;
    await tx.tikTokConnection.update({
      where: { id: ref.connectionId },
      data: { status: p.status, lastErrorCode: p.code, lastErrorMessage: p.message },
    });
    if (conn.status !== p.status)
      await tx.auditLog.createMany({
        data: [
          {
            tenantId: ref.tenantId,
            actorUserId: null,
            action: 'integration.needs_attention',
            targetType: 'tiktok_connection',
            targetId: ref.connectionId,
            metadata: { status: p.status, code: p.code },
          },
        ],
      });
  });
  deps.log({
    level: 'warn',
    event: 'tiktok.connection_problem',
    tenantId: ref.tenantId,
    connectionId: ref.connectionId,
    outcome: p.status,
  });
}

export interface ShopSession extends ShopContext {
  region: string | null;
  mock: boolean;
}

/**
 * Open the connection's tokens for one call. A token that is expired (or within a minute of it) is renewed first. Throws a
 * `token_invalid` TikTokApiError when the connection has no usable tokens (mock, disconnected, needs reconnecting).
 */
async function openSession(
  deps: TikTokAuthDeps,
  ref: { tenantId: string; connectionId: string },
): Promise<ShopSession> {
  const read = () =>
    deps.db.withContext({ tenantId: ref.tenantId }, (tx) =>
      tx.tikTokConnection.findFirst({ where: { id: ref.connectionId, tenantId: ref.tenantId } }),
    );
  let conn = await read();
  if (
    conn &&
    !conn.mock &&
    conn.accessTokenEnc &&
    (!conn.accessExpiresAt ||
      conn.accessExpiresAt.getTime() - deps.now().getTime() <= EXPIRY_SKEW_MS)
  ) {
    await refreshTikTokTokens(deps, ref, { force: true });
    conn = await read();
  }
  if (!conn || conn.mock || !conn.accessTokenEnc || conn.status === 'disconnected')
    throw new TikTokApiError('token_invalid', 'This connection has no usable access', null, null);
  if (conn.status === 'needs_reconnect')
    throw new TikTokApiError(
      'token_invalid',
      'This connection needs to be reconnected',
      null,
      null,
    );
  return {
    accessToken: deps.vault.decrypt(conn.accessTokenEnc, tiktokSecretScope(ref.tenantId, 'access')),
    shopCipher: conn.shopCipher,
    region: conn.region,
    mock: conn.mock,
  };
}

/**
 * Run a TikTok call for a connection. If TikTok says the access token is invalid, ONE forced renewal is tried and the call is
 * repeated once; anything else (and a second refusal) is thrown for the caller to record.
 */
export async function withTikTokShop<T>(
  deps: TikTokAuthDeps,
  ref: { tenantId: string; connectionId: string },
  fn: (session: ShopSession) => Promise<T>,
): Promise<T> {
  let session = await openSession(deps, ref);
  try {
    return await fn(session);
  } catch (error) {
    if (!(error instanceof TikTokApiError) || error.kind !== 'token_invalid') throw error;
    const renewed = await refreshTikTokTokens(deps, ref, { force: true });
    if (renewed !== 'refreshed') throw error;
    session = await openSession(deps, ref);
    return fn(session);
  }
}
