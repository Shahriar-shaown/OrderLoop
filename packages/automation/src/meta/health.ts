import { Database } from '@orderloop/db';
import type { Logger } from '../jobs.js';
import { MetaGraphClient, MetaGraphError } from './graph.js';
import type { SecretBox } from '../secret-box.js';

export interface HealthDeps {
  db: Database;
  graph: MetaGraphClient;
  vault: SecretBox;
  log: Logger;
  now: () => Date;
}

export type HealthOutcome =
  'ok' | 'needs_reconnect' | 'permission_error' | 'skipped' | 'unreachable';

/** The permission each kind of connection needs to receive messages. */
const REQUIRED_SCOPE = {
  facebook_page: 'pages_messaging',
  instagram: 'instagram_manage_messages',
} as const;

/** What to tell a person, with no token or Meta text in it. */
export const HEALTH_MESSAGES = {
  token_invalid: 'Meta no longer accepts the saved access. Reconnect this account.',
  permission_denied:
    'A permission this account needs was removed or is missing. Reconnect and approve all permissions.',
} as const;

/**
 * Check one connection with Meta (debug_token, then a plain read of the Page) and record what was found: `needs_reconnect` for
 * an invalid token (190), `permission_error` for a missing permission (10, 200, 299 or a scope that is gone), `active` again
 * when it works. Rate limits and outages change nothing: tomorrow's check tries again. Never throws for Meta's errors.
 */
export async function checkConnectionHealth(
  deps: HealthDeps,
  ref: { tenantId: string; connectionId: string },
): Promise<HealthOutcome> {
  const { tenantId, connectionId } = ref;
  const conn = await deps.db.withContext({ tenantId }, (tx) =>
    tx.socialConnection.findFirst({ where: { id: connectionId, tenantId } }),
  );
  if (!conn || conn.mock || conn.status === 'disconnected' || !conn.accessTokenEnc)
    return 'skipped';

  let problem: {
    status: 'needs_reconnect' | 'permission_error';
    code: string;
    message: string;
  } | null = null;
  try {
    const token = deps.vault.decrypt(conn.accessTokenEnc, {
      tenantId,
      provider: `meta_${conn.provider}`,
    });
    const debug = await deps.graph.debugToken(token);
    if (!debug.isValid)
      problem = {
        status: 'needs_reconnect',
        code: 'token_invalid',
        message: HEALTH_MESSAGES.token_invalid,
      };
    else if (debug.scopes && !debug.scopes.includes(REQUIRED_SCOPE[conn.provider]))
      problem = {
        status: 'permission_error',
        code: 'permission_denied',
        message: HEALTH_MESSAGES.permission_denied,
      };
    else await deps.graph.me(token);
  } catch (error) {
    if (error instanceof MetaGraphError && error.kind === 'token_invalid')
      problem = {
        status: 'needs_reconnect',
        code: 'token_invalid',
        message: HEALTH_MESSAGES.token_invalid,
      };
    else if (error instanceof MetaGraphError && error.kind === 'permission')
      problem = {
        status: 'permission_error',
        code: 'permission_denied',
        message: HEALTH_MESSAGES.permission_denied,
      };
    else {
      // rate limit, outage, bad request, or a token we cannot decrypt: say nothing new, try again tomorrow
      deps.log({
        level: 'warn',
        event: 'meta.health_unreachable',
        tenantId,
        connectionId,
        outcome: error instanceof MetaGraphError ? error.kind : 'error',
      });
      return 'unreachable';
    }
  }

  const now = deps.now();
  await deps.db.withContext({ tenantId }, async (tx) => {
    await tx.socialConnection.update({
      where: { id: connectionId },
      data: problem
        ? {
            status: problem.status,
            lastCheckedAt: now,
            lastErrorCode: problem.code,
            lastErrorMessage: problem.message,
          }
        : { status: 'active', lastCheckedAt: now, lastErrorCode: null, lastErrorMessage: null },
    });
    if (problem && problem.status !== conn.status)
      await tx.auditLog.createMany({
        data: [
          {
            tenantId,
            actorUserId: null,
            action: 'integration.needs_attention',
            targetType: 'social_connection',
            targetId: connectionId,
            metadata: { status: problem.status, code: problem.code },
          },
        ],
      });
  });
  deps.log({
    event: 'meta.health_checked',
    tenantId,
    connectionId,
    outcome: problem?.status ?? 'ok',
  });
  return problem?.status ?? 'ok';
}

/** Every live connection, paged by id; one that fails never stops the rest. */
export async function runHealthSweep(deps: HealthDeps): Promise<Record<HealthOutcome, number>> {
  const counts: Record<HealthOutcome, number> = {
    ok: 0,
    needs_reconnect: 0,
    permission_error: 0,
    skipped: 0,
    unreachable: 0,
  };
  let after: string | null = null;
  for (;;) {
    const page: { id: string; tenantId: string }[] = await deps.db.liveSocialConnections(
      after,
      200,
    );
    if (page.length === 0) break;
    for (const c of page) {
      try {
        counts[await checkConnectionHealth(deps, { tenantId: c.tenantId, connectionId: c.id })]++;
      } catch (error) {
        counts.unreachable++;
        deps.log({
          level: 'error',
          event: 'meta.health_failed',
          connectionId: c.id,
          error: (error as Error).name,
        });
      }
    }
    after = page.at(-1)!.id;
  }
  return counts;
}
