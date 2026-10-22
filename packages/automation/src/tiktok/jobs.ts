import { z } from 'zod';
import { jobIdOf, type JobQueue } from '../jobs.js';

export const TIKTOK_QUEUES = {
  /** One job per stored webhook event: fetches the order and updates the mirror and the stock. */
  events: 'tiktok-events',
  /** Three repeatable jobs (`sync`, `refresh`, `health`) on one queue: catch-up poll, token renewal, daily health check. */
  maintenance: 'tiktok-maintenance',
} as const;

/** Ids only: the order itself stays in the database, never in Redis. Re-validated by the worker. */
export const TikTokEventJob = z.object({ tenantId: z.string().uuid(), eventId: z.string().uuid() });
export type TikTokEventJob = z.infer<typeof TikTokEventJob>;

/** Five tries (10 s, 20 s, 40 s, 80 s apart); done jobs kept a day, failed ones a week. */
export const TIKTOK_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Events saved as `received` for this long were never queued (or fell out of the queue). */
export const TIKTOK_STALE_RECEIVED_SECONDS = 60;
export const TIKTOK_SWEEP_EVERY_MS = 30_000;
export const TIKTOK_PURGE_EVERY_MS = 3600_000;
/** TikTok gives up on a webhook after about 12 hours of retries, so a failed delivery is lost for good: this check closes the gap. */
export const TIKTOK_SYNC_EVERY_MS = 10 * 60_000;
export const TIKTOK_REFRESH_EVERY_MS = 15 * 60_000;
export const TIKTOK_HEALTH_EVERY_MS = 24 * 3600_000;

export const TIKTOK_SCHEDULES = {
  sync: { id: 'tiktok-sync', every: TIKTOK_SYNC_EVERY_MS },
  refresh: { id: 'tiktok-refresh', every: TIKTOK_REFRESH_EVERY_MS },
  health: { id: 'tiktok-health', every: TIKTOK_HEALTH_EVERY_MS },
} as const;
export type TikTokMaintenanceJob = keyof typeof TIKTOK_SCHEDULES;

/** Deterministic: the same event always gets the same id, so queueing it twice is a no-op. (BullMQ refuses ':' in an id.) */
export const tiktokEventJobId = (eventId: string) => jobIdOf('tiktok-event', eventId);

/**
 * Queue one event. Resolves false instead of waiting when Redis is slow or down: the webhook must answer TikTok within three
 * seconds, and the stored event is the source of truth (a sweeper queues what was missed).
 */
export async function enqueueTikTokEvent(
  queue: JobQueue,
  job: TikTokEventJob,
  timeoutMs = 1500,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      queue.add('event', job, { jobId: tiktokEventJobId(job.eventId), ...TIKTOK_JOB_OPTIONS }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('queue timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
