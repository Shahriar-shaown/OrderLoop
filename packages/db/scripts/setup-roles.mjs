// Idempotent dev/CI database bootstrap. Run with a superuser URL (DATABASE_ADMIN_URL), never at runtime.
//   app_migrator : owns the schema and tables, runs migrations, CREATEDB for Prisma's shadow database
//   app_user     : runtime role. NOSUPERUSER NOBYPASSRLS, so row-level security always applies
// Passwords are taken from DATABASE_MIGRATION_URL and DATABASE_URL so the .env stays the single source.
import pg from 'pg';

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (copy .env.example to .env)`);
  return new URL(v);
};
const admin = required('DATABASE_ADMIN_URL');
const migrator = required('DATABASE_MIGRATION_URL');
const runtime = required('DATABASE_URL');

const dbName = admin.pathname.slice(1);
const databases = [dbName, `${dbName}_test`];
const q = pg.escapeIdentifier;
const lit = pg.escapeLiteral;

async function withClient(database, fn) {
  const url = new URL(admin);
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureRole(client, url, extra) {
  const name = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  const verb = rowCount ? 'ALTER' : 'CREATE';
  await client.query(
    `${verb} ROLE ${q(name)} WITH LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION ${extra} PASSWORD ${lit(password)}`,
  );
  return name;
}

await withClient('postgres', async (client) => {
  const migratorName = await ensureRole(client, migrator, 'CREATEDB');
  await ensureRole(client, runtime, 'NOCREATEDB');
  for (const database of databases) {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      database,
    ]);
    if (!rowCount) await client.query(`CREATE DATABASE ${q(database)} OWNER ${q(migratorName)}`);
    await client.query(`REVOKE ALL ON DATABASE ${q(database)} FROM PUBLIC`);
    await client.query(
      `GRANT CONNECT ON DATABASE ${q(database)} TO ${q(decodeURIComponent(runtime.username))}`,
    );
    await client.query(`GRANT CONNECT ON DATABASE ${q(database)} TO ${q(migratorName)}`);
  }
});

for (const database of databases) {
  await withClient(database, async (client) => {
    const m = q(decodeURIComponent(migrator.username));
    const u = q(decodeURIComponent(runtime.username));
    await client.query(`ALTER SCHEMA public OWNER TO ${m}`);
    await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${u}`);
    // Tables created by later migrations are readable and writable by the runtime role.
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${m} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${u}`,
    );
    // Sequences created by later migrations (serial columns) are usable by the runtime role.
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${m} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${u}`,
    );
    // Deliberately NO blanket "GRANT ... ON ALL TABLES": re-running setup would undo the per-table
    // REVOKEs in the migrations (append-only audit_logs, no access to _prisma_migrations).
  });
}
console.log(`database roles ready for: ${databases.join(', ')}`);
