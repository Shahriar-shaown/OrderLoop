import type { Database } from '@orderloop/db';
import type { TikTokOrderSnapshot } from '@orderloop/domain';
import { TikTokApiError } from './client.js';
import { noopTikTokMetrics, type TikTokMetrics } from './metrics.js';
import { parseTikTokOrder } from './parse.js';
import { reportApply, type TikTokOrderSink } from './sink.js';
import { recordTikTokProblem, withTikTokShop, type TikTokAuthDeps } from './tokens.js';

export interface TikTokSyncDeps extends TikTokAuthDeps {
  sink: TikTokOrderSink;
  /** Injected so tests do not really wait while backing off. */
  sleep?: (ms: number) => Promise<void>;
}

/** Orders changed up to this long before the last finished check are read again (clock differences, orders that commit late). */
export const SYNC_OVERLAP_MS = 10 * 60_000;
export const SYNC_PAGE_SIZE = 50;
/** At most this many pages (of 50 orders) per run: a huge backlog is read over several runs, oldest change first. */
export const SYNC_MAX_PAGES = 10;
/** The first read, when a shop is connected. */
export const SYNC_BACKFILL_DAYS = 7;
/** Orders waiting for a SKU link or for stock that are looked at again per run. */
const WAITING_LIMIT = 200;

export interface TikTokSyncOutcome {
  fetched: number;
  updated: number;
  reconciled: number;
  truncated: boolean;
}

const BACKOFF_MS = [1000, 3000];
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A call that is retried (twice, 1 s then 3 s) while TikTok says "slow down". Other failures are not retried here. */
async function withRateBackoff<T>(
  sleep: (ms: number) => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (
        !(error instanceof TikTokApiError) ||
        error.kind !== 'rate_limited' ||
        attempt >= BACKOFF_MS.length
      )
        throw error;
      await sleep(BACKOFF_MS[attempt]!);
    }
  }
}

/** Run the stock rules again for the orders that were waiting. Each in its own transaction, so one never blocks the rest. */
export async function reconcileWaitingTikTokOrders(
  deps: { db: Database; sink: TikTokOrderSink; metrics?: TikTokMetrics },
  ref: { tenantId: string; connectionId: string },
): Promise<number> {
  const metrics = deps.metrics ?? noopTikTokMetrics;
  const ids = await deps.db.withContext({ tenantId: ref.tenantId }, (tx) =>
    deps.sink.waiting(tx, { ...ref, limit: WAITING_LIMIT }),
  );
  let n = 0;
  for (const orderId of ids) {
    const r = await deps.db.withContext({ tenantId: ref.tenantId }, (tx) =>
      deps.sink.reconcile(tx, { tenantId: ref.tenantId, orderId }),
    );
    reportApply(metrics, r);
    n++;
  }
  return n;
}

/**
 * The catch-up check, per connection: TikTok drops a webhook for good after about 12 hours of failed retries, so this reads
 * every order changed since the last finished check (with an overlap) and puts each through the SAME path a webhook uses
 * (`sink.apply`: upsert never backwards, link SKUs, move stock). It advances `last_synced_at` only as far as it really got.
 * A mock shop has no remote: only its waiting orders are looked at again.
 */
export async function syncTikTokConnection(
  deps: TikTokSyncDeps,
  ref: { tenantId: string; connectionId: string },
  opts: { since?: Date } = {},
): Promise<TikTokSyncOutcome> {
  const { tenantId, connectionId } = ref;
  const metrics = deps.metrics ?? noopTikTokMetrics;
  const sleep = deps.sleep ?? realSleep;
  const out: TikTokSyncOutcome = { fetched: 0, updated: 0, reconciled: 0, truncated: false };
  const conn = await deps.db.withContext({ tenantId }, (tx) =>
    tx.tikTokConnection.findFirst({ where: { id: connectionId, tenantId } }),
  );
  if (!conn || conn.status === 'disconnected') return out;

  if (!conn.mock && conn.status !== 'needs_reconnect') {
    const runStart = deps.now();
    const since =
      opts.since ??
      conn.lastSyncedAt ??
      new Date(runStart.getTime() - SYNC_BACKFILL_DAYS * 86_400_000);
    const ge = Math.floor((since.getTime() - SYNC_OVERLAP_MS) / 1000);
    const lt = Math.floor(runStart.getTime() / 1000) + 1;
    let pageToken: string | undefined;
    let newest = since.getTime();
    let finished = false;
    try {
      for (let page = 0; page < SYNC_MAX_PAGES; page++) {
        const found = await withRateBackoff(sleep, () =>
          withTikTokShop(deps, { tenantId, connectionId }, (session) =>
            deps.client.searchOrders(session, {
              updateTimeGe: ge,
              updateTimeLt: lt,
              pageToken,
              pageSize: SYNC_PAGE_SIZE,
            }),
          ),
        );
        // The search may return only ids; whatever lacks its lines is read in full.
        const snapshots: TikTokOrderSnapshot[] = [];
        const incomplete: string[] = [];
        for (const raw of found.orders) {
          const o = raw as { id?: unknown; line_items?: unknown } | null;
          if (o && Array.isArray(o.line_items)) {
            const s = parseTikTokOrder(raw, { region: conn.region, fallbackUpdatedAt: runStart });
            if (s) snapshots.push(s);
          } else if (o && typeof o.id === 'string') incomplete.push(o.id);
        }
        for (let i = 0; i < incomplete.length; i += 50) {
          const full = await withRateBackoff(sleep, () =>
            withTikTokShop(deps, { tenantId, connectionId }, (session) =>
              deps.client.getOrders(session, incomplete.slice(i, i + 50)),
            ),
          );
          for (const raw of full) {
            const s = parseTikTokOrder(raw, { region: conn.region, fallbackUpdatedAt: runStart });
            if (s) snapshots.push(s);
          }
        }
        out.fetched += found.orders.length;
        for (const snapshot of snapshots) {
          const r = await deps.db.withContext({ tenantId }, (tx) =>
            deps.sink.apply(tx, { tenantId, connectionId, mock: false, snapshot }),
          );
          if (r.applied) out.updated++;
          reportApply(metrics, r);
          newest = Math.max(newest, snapshot.statusUpdatedAt.getTime());
        }
        if (!found.nextPageToken) {
          finished = true;
          break;
        }
        pageToken = found.nextPageToken;
      }
      out.truncated = !finished;
      await deps.db.withContext({ tenantId }, (tx) =>
        tx.tikTokConnection.updateMany({
          where: { id: connectionId, tenantId, status: { not: 'disconnected' } },
          data: {
            // Fully read: up to the moment this run began. Cut short: only as far as the changes actually read, plus the overlap
            // the next run subtracts again, so it restarts AT the newest change it read (never re-reading a window bigger than
            // one run can hold, which would stall for ever) but not beyond now.
            lastSyncedAt: finished
              ? runStart
              : new Date(Math.min(newest + SYNC_OVERLAP_MS, runStart.getTime())),
            ...(conn.status === 'active' ? { lastErrorCode: null, lastErrorMessage: null } : {}),
          },
        }),
      );
    } catch (error) {
      if (
        error instanceof TikTokApiError &&
        (error.kind === 'token_invalid' || error.kind === 'permission')
      )
        await recordTikTokProblem(deps, ref, error.kind);
      else if (error instanceof TikTokApiError) {
        // A rate limit that did not clear, an outage, a bad request: leave last_synced_at alone, so the next run reads it all again.
        deps.log({
          level: 'warn',
          event: 'tiktok.sync_failed',
          tenantId,
          connectionId,
          outcome: error.kind,
        });
      } else throw error;
    }
  }
  out.reconciled = await reconcileWaitingTikTokOrders(deps, ref);
  return out;
}

/** Every live connection, paged by id; one that fails never stops the rest. */
export async function runTikTokSyncSweep(
  deps: TikTokSyncDeps,
): Promise<{ connections: number; failed: number }> {
  let connections = 0;
  let failed = 0;
  let after: string | null = null;
  for (;;) {
    const page: { id: string; tenantId: string }[] = await deps.db.liveTikTokConnections(
      after,
      200,
    );
    if (page.length === 0) break;
    for (const c of page) {
      connections++;
      try {
        await syncTikTokConnection(deps, { tenantId: c.tenantId, connectionId: c.id });
      } catch (error) {
        failed++;
        deps.log({
          level: 'error',
          event: 'tiktok.sync_error',
          connectionId: c.id,
          error: (error as Error).name,
        });
      }
    }
    after = page.at(-1)!.id;
  }
  return { connections, failed };
}
