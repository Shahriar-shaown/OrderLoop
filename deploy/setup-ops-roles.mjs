// Two extra roles for operations, created by the migrate job so nothing is configured by hand (idempotent):
//
//   app_backup  : pg_dump. NOSUPERUSER, BYPASSRLS, member of pg_read_all_data. The tables use FORCE ROW LEVEL SECURITY, so even
//                 their owner sees nothing without a tenant context, and a dump taken as the owner (or with --enable-row-security)
//                 is silently EMPTY of tenant data (found in the pre-pilot review). A role that bypasses RLS and can only READ is
//                 the least privilege that produces a complete dump. It cannot write, create or log in from the application.
//   app_monitor : the metrics exporter. NOSUPERUSER, NOBYPASSRLS, member of pg_monitor (statistics and activity only, no table data).
//
// Passwords come from DATABASE_BACKUP_PASSWORD and DATABASE_MONITOR_PASSWORD; a role whose password is unset is skipped.
import pg from 'pg';

const admin = process.env.DATABASE_ADMIN_URL;
if (!admin) throw new Error('DATABASE_ADMIN_URL is not set');
const dbName = new URL(admin).pathname.slice(1);
const q = pg.escapeIdentifier;
const lit = pg.escapeLiteral;

const roles = [
  {
    name: 'app_backup',
    password: process.env.DATABASE_BACKUP_PASSWORD,
    attrs: 'BYPASSRLS',
    member: 'pg_read_all_data',
  },
  {
    name: 'app_monitor',
    password: process.env.DATABASE_MONITOR_PASSWORD,
    attrs: 'NOBYPASSRLS',
    member: 'pg_monitor',
  },
];

const client = new pg.Client({ connectionString: admin });
await client.connect();
try {
  for (const role of roles) {
    if (!role.password) {
      console.log(`ops role ${role.name}: skipped (no password set)`);
      continue;
    }
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
      role.name,
    ]);
    await client.query(
      `${rowCount ? 'ALTER' : 'CREATE'} ROLE ${q(role.name)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${role.attrs} PASSWORD ${lit(role.password)}`,
    );
    await client.query(`GRANT ${q(role.member)} TO ${q(role.name)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${q(dbName)} TO ${q(role.name)}`);
    console.log(`ops role ${role.name}: ready (${role.member})`);
  }
} finally {
  await client.end();
}
