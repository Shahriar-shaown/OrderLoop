import type { Database } from '@orderloop/db';
import type { JobQueue, Logger } from '../jobs.js';
import { STALE_RECEIVED_SECONDS, enqueueSocialEvent } from './jobs.js';

export const SOCIAL_SWEEP_EVERY_MS = 30_000;

/**
 * Queue every event that was stored but never processed (the API answered Meta, then Redis was down or the process died).
 * Safe to repeat and to overlap: the job id is derived from the event id, and the processor claims the row under a lock.
 */
export async function sweepReceivedSocialEvents(deps: {
  db: Database;
  queue: JobQueue;
  log: Logger;
}): Promise<number> {
  const stale = await deps.db.staleReceivedSocialEvents(STALE_RECEIVED_SECONDS);
  let queued = 0;
  for (const e of stale)
    if (await enqueueSocialEvent(deps.queue, { tenantId: e.tenantId, eventId: e.id }, 5000))
      queued++;
  if (stale.length) deps.log({ event: 'meta.swept', found: stale.length, queued });
  return queued;
}
