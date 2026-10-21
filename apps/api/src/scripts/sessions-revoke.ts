// Incident response: sign people out everywhere by revoking their sessions (sets sessions.revoked_at).
// Run: pnpm sessions:revoke --all | --user <email> | --tenant <business id>   [--yes]
// Without --yes it only prints how many sessions would be revoked (dry run). --tenant means every member of that business.
// Connects as DATABASE_ADMIN_URL (bypasses row-level security). Prints one JSON log line with counts; never any token.
import { loadDotEnv } from '@orderloop/contracts/server';
import pg from 'pg';
import { parseRevokeArgs, revokeSessions } from '../auth/revoke-sessions.js';

loadDotEnv();
let parsed;
try {
  parsed = parseRevokeArgs(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  console.error('Usage: pnpm sessions:revoke --all | --user <email> | --tenant <id> [--yes]');
  process.exit(2);
}
const url = process.env['DATABASE_ADMIN_URL'];
if (!url) {
  console.error('DATABASE_ADMIN_URL is not set (see .env.example): this reads every business.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const result = await revokeSessions(client, parsed.scope, parsed.yes);
  const target =
    parsed.scope.kind === 'all'
      ? 'all'
      : parsed.scope.kind === 'user'
        ? parsed.scope.email
        : parsed.scope.tenantId;
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      event: 'sessions.revoke',
      scope: result.scope,
      target,
      dryRun: result.dryRun,
      matched: result.matched,
      revoked: result.revoked,
    }),
  );
  if (result.dryRun)
    console.log(`Dry run: ${result.matched} live session(s) would be revoked. Add --yes to do it.`);
  else console.log(`Revoked ${result.revoked} session(s).`);
} finally {
  await client.end();
}
