import {
  applyMovement,
  StockInvariantError,
  type Movement,
  type StockLevel,
} from '@orderloop/domain';

/** The one thing the check needs from a PostgreSQL client (satisfied by `pg`'s Client and Pool). */
export interface SqlReader {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface LedgerDrift {
  tenantId: string;
  variantId: string;
  locationId: string;
  /** What the stock level table says (null: no such row). */
  stored: StockLevel | null;
  /** What replaying the movements gives (null: the replay itself broke an invariant, see `problem`). */
  replayed: StockLevel | null;
  problem: string;
}

export interface LedgerReport {
  movements: number;
  levels: number;
  drift: LedgerDrift[];
}

const BATCH = 10_000;
const ZERO: StockLevel = { onHand: 0, reserved: 0, damaged: 0 };
const keyOf = (tenantId: unknown, variantId: unknown, locationId: unknown) =>
  `${tenantId}|${variantId}|${locationId}`;

/**
 * Replay every stock movement, in ledger order, per (tenant, variant, location) with the same pure rules the database
 * enforces (`applyMovement`), and compare the result with `stock_levels`. Read only. Needs a role that sees every tenant
 * (row-level security would otherwise hide the rows): the operator's admin connection, never the app's.
 */
export async function verifyLedger(db: SqlReader): Promise<LedgerReport> {
  const replayed = new Map<string, StockLevel>();
  const broken = new Map<string, string>();
  let movements = 0;
  let after = '0';
  for (;;) {
    const { rows } = await db.query(
      // `ORDER BY stock_movements.seq`, not the alias: a bare `seq` would sort the text alias ("21" before "3").
      `SELECT seq::text AS seq_text, tenant_id, variant_id, location_id, type::text AS type,
              on_hand_delta, reserved_delta, damaged_delta
       FROM stock_movements WHERE seq > $1::bigint ORDER BY stock_movements.seq LIMIT ${BATCH}`,
      [after],
    );
    for (const r of rows) {
      const key = keyOf(r['tenant_id'], r['variant_id'], r['location_id']);
      movements++;
      after = String(r['seq_text']);
      if (broken.has(key)) continue;
      try {
        replayed.set(
          key,
          applyMovement(replayed.get(key) ?? ZERO, {
            type: r['type'] as Movement['type'],
            onHandDelta: Number(r['on_hand_delta']),
            reservedDelta: Number(r['reserved_delta']),
            damagedDelta: Number(r['damaged_delta']),
          }),
        );
      } catch (error) {
        if (!(error instanceof StockInvariantError)) throw error;
        broken.set(key, `movement #${after}: ${error.message}`);
      }
    }
    if (rows.length < BATCH) break;
  }

  const stored = await db.query(
    'SELECT tenant_id, variant_id, location_id, on_hand, reserved, damaged FROM stock_levels',
  );
  const drift: LedgerDrift[] = [];
  const seen = new Set<string>();
  const ids = (key: string) => {
    const [tenantId, variantId, locationId] = key.split('|') as [string, string, string];
    return { tenantId, variantId, locationId };
  };
  for (const r of stored.rows) {
    const key = keyOf(r['tenant_id'], r['variant_id'], r['location_id']);
    seen.add(key);
    const level: StockLevel = {
      onHand: Number(r['on_hand']),
      reserved: Number(r['reserved']),
      damaged: Number(r['damaged']),
    };
    const want = replayed.get(key) ?? ZERO;
    const problem = broken.get(key);
    if (problem) drift.push({ ...ids(key), stored: level, replayed: null, problem });
    else if (
      want.onHand !== level.onHand ||
      want.reserved !== level.reserved ||
      want.damaged !== level.damaged
    )
      drift.push({
        ...ids(key),
        stored: level,
        replayed: want,
        problem: 'the stored level differs from the ledger',
      });
  }
  for (const [key, want] of replayed)
    if (!seen.has(key))
      drift.push({
        ...ids(key),
        stored: null,
        replayed: want,
        problem: 'movements without a stock level row',
      });
  for (const [key, problem] of broken)
    if (!seen.has(key)) drift.push({ ...ids(key), stored: null, replayed: null, problem });
  return { movements, levels: stored.rows.length, drift };
}

const level = (l: StockLevel | null) =>
  l ? `onHand=${l.onHand} reserved=${l.reserved} damaged=${l.damaged}` : 'none';

/** One line per drifted stock level, then a verdict. */
export function formatReport(report: LedgerReport): string[] {
  const lines = report.drift.map(
    (d) =>
      `DRIFT tenant=${d.tenantId} variant=${d.variantId} location=${d.locationId}: ${d.problem} (stored: ${level(d.stored)}; ledger: ${level(d.replayed)})`,
  );
  lines.push(
    report.drift.length
      ? `${report.drift.length} of ${report.levels} stock levels do not match the ledger (${report.movements} movements replayed).`
      : `OK: ${report.levels} stock levels match the ledger (${report.movements} movements replayed).`,
  );
  return lines;
}
