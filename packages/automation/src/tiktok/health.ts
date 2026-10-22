import { TikTokApiError } from './client.js';
import {
  TIKTOK_PROBLEMS,
  recordTikTokProblem,
  withTikTokShop,
  type TikTokAuthDeps,
} from './tokens.js';

export type TikTokHealthOutcome =
  'ok' | 'needs_reconnect' | 'permission_error' | 'skipped' | 'unreachable';

/**
 * Check one connection with TikTok (the list of authorised shops: it needs a good token and the shop must still be in it) and
 * record what was found: `needs_reconnect` for a refused token, `permission_error` for a refused permission or a shop that is no
 * longer authorised, `active` again when it works. A rate limit or an outage changes nothing: tomorrow's check tries again.
 * Never throws for TikTok's errors.
 */
export async function checkTikTokConnectionHealth(
  deps: TikTokAuthDeps,
  ref: { tenantId: string; connectionId: string },
): Promise<TikTokHealthOutcome> {
  const { tenantId, connectionId } = ref;
  const conn = await deps.db.withContext({ tenantId }, (tx) =>
    tx.tikTokConnection.findFirst({ where: { id: connectionId, tenantId } }),
  );
  if (!conn || conn.mock || conn.status === 'disconnected' || !conn.accessTokenEnc)
    return 'skipped';
  try {
    const shops = await withTikTokShop(deps, ref, (session) =>
      deps.client.getAuthorizedShops(session.accessToken),
    );
    if (!shops.some((s) => s.id === conn.shopId)) {
      await recordTikTokProblem(deps, ref, 'permission');
      return 'permission_error';
    }
  } catch (error) {
    if (
      error instanceof TikTokApiError &&
      (error.kind === 'token_invalid' || error.kind === 'permission')
    ) {
      await recordTikTokProblem(deps, ref, error.kind);
      return TIKTOK_PROBLEMS[error.kind].status;
    }
    deps.log({
      level: 'warn',
      event: 'tiktok.health_unreachable',
      tenantId,
      connectionId,
      outcome: error instanceof TikTokApiError ? error.kind : 'error',
    });
    return 'unreachable';
  }
  await deps.db.withContext({ tenantId }, (tx) =>
    tx.tikTokConnection.update({
      where: { id: connectionId },
      data: {
        status: 'active',
        lastCheckedAt: deps.now(),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    }),
  );
  deps.log({ event: 'tiktok.health_checked', tenantId, connectionId, outcome: 'ok' });
  return 'ok';
}

/** Every live connection, paged by id; one that fails never stops the rest. */
export async function runTikTokHealthSweep(
  deps: TikTokAuthDeps,
): Promise<Record<TikTokHealthOutcome, number>> {
  const counts: Record<TikTokHealthOutcome, number> = {
    ok: 0,
    needs_reconnect: 0,
    permission_error: 0,
    skipped: 0,
    unreachable: 0,
  };
  let after: string | null = null;
  for (;;) {
    const page: { id: string; tenantId: string }[] = await deps.db.liveTikTokConnections(
      after,
      200,
    );
    if (page.length === 0) break;
    for (const c of page) {
      try {
        counts[
          await checkTikTokConnectionHealth(deps, { tenantId: c.tenantId, connectionId: c.id })
        ]++;
      } catch (error) {
        counts.unreachable++;
        deps.log({
          level: 'error',
          event: 'tiktok.health_failed',
          connectionId: c.id,
          error: (error as Error).name,
        });
      }
    }
    after = page.at(-1)!.id;
  }
  return counts;
}
