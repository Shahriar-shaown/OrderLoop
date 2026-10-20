import { IMPORT_JOB_OPTIONS } from '@orderloop/catalog';

export interface ImportRef {
  tenantId: string;
  importId: string;
}

/** Imports PENDING for this long were never queued (or fell out of the queue); normal ones are taken within seconds. */
export const STALE_PENDING_MS = 60_000;
export const SWEEP_EVERY_MS = 30_000;

/**
 * Queue every stale PENDING import again. Safe to repeat and to overlap with the API or another worker: the job id is the
 * import id, so a job already in the queue is left alone, and the worker claims the row atomically besides.
 */
export async function sweepPendingImports(deps: {
  find: (olderThanMs: number) => Promise<ImportRef[]>;
  queue: { add: (name: string, data: ImportRef, opts: object) => Promise<unknown> };
  log: (message: string) => void;
}): Promise<number> {
  const stale = await deps.find(STALE_PENDING_MS);
  for (const data of stale) {
    await deps.queue.add('products', data, { jobId: data.importId, ...IMPORT_JOB_OPTIONS });
    deps.log(`re-queued import ${data.importId}, which was saved but never queued`);
  }
  return stale.length;
}
