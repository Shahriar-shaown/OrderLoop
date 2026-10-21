import { IMPORT_JOB_OPTIONS } from '@orderloop/catalog';

export interface ImportRef {
  tenantId: string;
  importId: string;
}

/** Imports PENDING for this long were never queued (or fell out of the queue); normal ones are taken within seconds. */
export const STALE_PENDING_MS = 60_000;
/**
 * RUNNING for this long means the worker that took it is gone and Redis lost the job (a job Redis still holds is redelivered
 * by BullMQ itself). Longer than the claim's own 10-minute stall rule (STALL_MS in catalog), which a re-queued job must pass.
 */
export const STALLED_RUNNING_MS = 15 * 60_000;
export const SWEEP_EVERY_MS = 30_000;

/**
 * Queue every stale PENDING import again. Safe to repeat and to overlap with the API or another worker: the job id is the
 * import id, so a job already in the queue is left alone, and the worker claims the row atomically besides.
 */
export async function sweepPendingImports(deps: {
  find: (olderThanMs: number) => Promise<ImportRef[]>;
  /** Also re-queue imports left RUNNING by a worker that died when Redis lost the job (omit to skip). */
  findStalledRunning?: (olderThanMs: number) => Promise<ImportRef[]>;
  queue: { add: (name: string, data: ImportRef, opts: object) => Promise<unknown> };
  log: (message: string) => void;
}): Promise<number> {
  const stale = await deps.find(STALE_PENDING_MS);
  for (const data of stale) {
    await deps.queue.add('products', data, { jobId: data.importId, ...IMPORT_JOB_OPTIONS });
    deps.log(`re-queued import ${data.importId}, which was saved but never queued`);
  }
  // The job id is the import id: if BullMQ still holds the job (a slow import, or a stalled one it will redeliver itself) this
  // add is a no-op. If Redis was wiped it creates the job; the worker then takes over the RUNNING row (its own stall rule,
  // 10 minutes without a restart, is already met) and resumes: every row is idempotent.
  const stalled = deps.findStalledRunning ? await deps.findStalledRunning(STALLED_RUNNING_MS) : [];
  for (const data of stalled) {
    await deps.queue.add('products', data, { jobId: data.importId, ...IMPORT_JOB_OPTIONS });
    deps.log(`re-queued import ${data.importId}, which was left running by a worker that is gone`);
  }
  return stale.length + stalled.length;
}
