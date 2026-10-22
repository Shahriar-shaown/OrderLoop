import type { Logger } from '@orderloop/automation';
import type { Database } from '@orderloop/db';

export const TENANT_PURGE_QUEUE = 'tenant-purge';
/** One scheduler under a fixed id: however many workers start, the purge runs once an hour. */
export const TENANT_PURGE_SCHEDULER_ID = 'tenant-purge';
export const TENANT_PURGE_EVERY_MS = 3600_000;
/** Businesses handled per run; the rest wait for the next hour (there are few: each is a deliberate request). */
const BATCH = 20;

export interface PurgeDeps {
  db: Pick<Database, 'tenantsDueForPurge' | 'purgeTenant'>;
  log: Logger;
}

export interface PurgeSummary {
  purged: number;
  skipped: number;
  failed: number;
}

/**
 * Delete the businesses whose owner asked for it and whose grace period is over. The decision lives in the database
 * (`tenants_due_for_purge` finds them, `purge_tenant` re-checks and deletes), so a repeat, a second worker, or a business
 * whose deletion was cancelled in the meantime is harmless: it comes back as `purged: false`. A failure on one business
 * is logged and does not stop the others. Logs hold ids and row counts only, never names or contents.
 */
export async function runTenantPurge(deps: PurgeDeps): Promise<PurgeSummary> {
  const summary: PurgeSummary = { purged: 0, skipped: 0, failed: 0 };
  for (const tenantId of await deps.db.tenantsDueForPurge(BATCH)) {
    try {
      const r = await deps.db.purgeTenant(tenantId);
      if (!r.purged) {
        summary.skipped++;
        continue;
      }
      summary.purged++;
      deps.log({
        level: 'info',
        event: 'tenant.purged',
        tenantId,
        rows: r.rowsDeleted,
        tables: r.counts,
        userAnonymised: r.userAnonymised,
      });
    } catch (error) {
      summary.failed++;
      deps.log({
        level: 'error',
        event: 'tenant.purge_failed',
        tenantId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return summary;
}

export interface PurgeSchedulerQueue {
  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; data: object; opts: object },
  ): Promise<unknown>;
}

/** Register the ONE hourly purge (idempotent by scheduler id, like the automation tick). */
export async function registerTenantPurge(queue: PurgeSchedulerQueue): Promise<void> {
  await queue.upsertJobScheduler(
    TENANT_PURGE_SCHEDULER_ID,
    { every: TENANT_PURGE_EVERY_MS },
    {
      name: 'purge',
      data: {},
      opts: { removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } },
    },
  );
}
