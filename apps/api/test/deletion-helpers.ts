import { TENANT_TABLES } from '@orderloop/db';
import pg from 'pg';
import { testEnv } from './test-env.js';

/** A superuser connection to the isolated test database: sees every row (no row-level security), for asserting what is left. */
export async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = new URL(testEnv.DATABASE_ADMIN_URL);
  url.pathname = '/orderloop_test';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const scope = (table: string) => (table === 'tenants' ? 'id' : 'tenant_id');

export interface TextCell {
  table: string;
  column: string;
  value: string;
}

/** Every text-like value (text, varchar, json, arrays) of every tenant table, for one tenant: the "no personal data left anywhere" scan. */
export async function tenantText(client: pg.Client, tenantId: string): Promise<TextCell[]> {
  const cols = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1)
       AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')`,
    [[...TENANT_TABLES]],
  );
  const out: TextCell[] = [];
  for (const { table_name: table, column_name: column } of cols.rows) {
    const rows = await client.query<{ v: string | null }>(
      `SELECT "${column}"::text AS v FROM "${table}" WHERE ${scope(table)} = $1`,
      [tenantId],
    );
    for (const r of rows.rows) if (r.v !== null) out.push({ table, column, value: r.v });
  }
  return out;
}

/** Rows each tenant table holds for one tenant. */
export async function tenantRowCounts(
  client: pg.Client,
  tenantId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TENANT_TABLES) {
    const r = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}" WHERE ${scope(table)} = $1`,
      [tenantId],
    );
    counts[table] = Number(r.rows[0]!.n);
  }
  return counts;
}

/** Where (table.column) any of the needles still appears, case-insensitively. Empty when nothing does. */
export function findLeaks(cells: TextCell[], needles: string[]): string[] {
  const lower = needles.map((n) => n.toLowerCase());
  const hits = new Set<string>();
  for (const c of cells) {
    const v = c.value.toLowerCase();
    if (lower.some((n) => v.includes(n))) hits.add(`${c.table}.${c.column}`);
  }
  return [...hits].sort();
}
