import type pg from 'pg';

export type RevokeScope =
  { kind: 'all' } | { kind: 'user'; email: string } | { kind: 'tenant'; tenantId: string };

export interface RevokeResult {
  scope: RevokeScope['kind'];
  /** Live sessions (not revoked, not expired) that match. */
  matched: number;
  /** Sessions actually revoked: 0 on a dry run. */
  revoked: number;
  dryRun: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIVE = 'revoked_at IS NULL AND expires_at > now()';

/** The WHERE clause for a scope (parameterised). `tenant` means every member of that business: any of their sessions could switch into it. */
function where(scope: RevokeScope): { sql: string; params: string[] } {
  switch (scope.kind) {
    case 'all':
      return { sql: LIVE, params: [] };
    case 'user':
      return {
        sql: `${LIVE} AND user_id IN (SELECT id FROM users WHERE email = $1)`,
        params: [scope.email.trim().toLowerCase()],
      };
    case 'tenant':
      return {
        sql: `${LIVE} AND user_id IN (SELECT user_id FROM memberships WHERE tenant_id = $1::uuid)`,
        params: [scope.tenantId],
      };
  }
}

/**
 * Revoke live sessions (sets `revoked_at`; refresh tokens stop working because the session is revoked, access tokens stop
 * verifying on their next request since the guard re-reads the session). Must run as a role that bypasses row-level security.
 * Without `execute` it only counts. Never reads or prints a token.
 */
export async function revokeSessions(
  client: Pick<pg.Client, 'query'>,
  scope: RevokeScope,
  execute: boolean,
): Promise<RevokeResult> {
  if (scope.kind === 'tenant' && !UUID.test(scope.tenantId))
    throw new Error('--tenant must be a business id (UUID)');
  if (scope.kind === 'user' && !scope.email.includes('@'))
    throw new Error('--user must be an email address');
  const { sql, params } = where(scope);
  if (!execute) {
    const r = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions WHERE ${sql}`,
      params,
    );
    return { scope: scope.kind, matched: Number(r.rows[0]!.n), revoked: 0, dryRun: true };
  }
  const r = await client.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = 'incident' WHERE ${sql}`,
    params,
  );
  return { scope: scope.kind, matched: r.rowCount ?? 0, revoked: r.rowCount ?? 0, dryRun: false };
}

/** `--all | --user <email> | --tenant <id>`, plus `--yes`. Exactly one scope. */
export function parseRevokeArgs(argv: string[]): { scope: RevokeScope; yes: boolean } {
  let scope: RevokeScope | undefined;
  let yes = false;
  const set = (s: RevokeScope) => {
    if (scope) throw new Error('Give exactly one of --all, --user <email>, --tenant <id>');
    scope = s;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') set({ kind: 'all' });
    else if (a === '--') continue;
    else if (a === '--yes') yes = true;
    else if (a === '--user' || a === '--tenant') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      set(a === '--user' ? { kind: 'user', email: v } : { kind: 'tenant', tenantId: v });
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!scope) throw new Error('Give exactly one of --all, --user <email>, --tenant <id>');
  return { scope, yes };
}
