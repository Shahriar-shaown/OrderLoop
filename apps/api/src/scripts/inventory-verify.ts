// Operational ledger check: replays every stock movement and compares the result with the stored stock levels.
// Read only. Exits 1 when any level has drifted, so it can run from cron or CI.
// Run: pnpm inventory:verify
// It must see every business at once, so it connects as DATABASE_ADMIN_URL (a role that bypasses row-level security),
// not as the app's role.
import { loadDotEnv } from '@orderloop/contracts/server';
import pg from 'pg';
import { formatReport, verifyLedger } from '../inventory/ledger-check.js';

loadDotEnv();
const url = process.env['DATABASE_ADMIN_URL'];
if (!url) {
  console.error(
    'DATABASE_ADMIN_URL is not set. The check reads every business, so it needs the admin connection (see .env.example).',
  );
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');
  const report = await verifyLedger(client);
  for (const line of formatReport(report)) console.log(line);
  process.exitCode = report.drift.length ? 1 : 0;
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  await client.end();
}
