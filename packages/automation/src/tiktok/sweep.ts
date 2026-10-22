import type { Database } from '@orderloop/db';
import type { JobQueue, Logger } from '../jobs.js';
import { TIKTOK_STALE_RECEIVED_SECONDS, enqueueTikTokEvent } from './jobs.js';

/**
 * Queue every event that was stored but never processed (the API answered TikTok, then Redis was down or the process died).
 * Safe to repeat and to overlap: the job id is derived from the event id, and the processor claims the row under a lock.
 */
export async function sweepReceivedTikTokEvents(deps: {
  db: Database;
  queue: JobQueue;
  log: Logger;
}): Promise<number> {
  const stale = await deps.db.staleReceivedTikTokEvents(TIKTOK_STALE_RECEIVED_SECONDS);
  let queued = 0;
  for (const e of stale)
    if (await enqueueTikTokEvent(deps.queue, { tenantId: e.tenantId, eventId: e.id }, 5000))
      queued++;
  if (stale.length) deps.log({ event: 'tiktok.swept', found: stale.length, queued });
  return queued;
}
