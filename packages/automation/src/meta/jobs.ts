import { z } from 'zod';
import { jobIdOf, type JobQueue } from '../jobs.js';

export const META_QUEUES = {
  /** One job per stored webhook event: turns it into (or adds it to) a draft. */
  events: 'meta-events',
  /** One repeatable job a day: checks every live connection. */
  health: 'meta-health',
} as const;

/** Ids only: the message itself stays in the database, never in Redis. Re-validated by the worker. */
export const SocialEventJob = z.object({ tenantId: z.string().uuid(), eventId: z.string().uuid() });
export type SocialEventJob = z.infer<typeof SocialEventJob>;

/** Five tries (10 s, 20 s, 40 s, 80 s apart); done jobs kept a day, failed ones a week. */
export const META_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Events saved as `received` for this long were never queued (or fell out of the queue). */
export const STALE_RECEIVED_SECONDS = 60;
export const HEALTH_EVERY_MS = 24 * 3600_000;
export const HEALTH_SCHEDULER_ID = 'meta-health';

/** Deterministic: the same event always gets the same id, so queueing it twice is a no-op. (BullMQ refuses ':' in an id.) */
export const socialEventJobId = (eventId: string) => jobIdOf('social-event', eventId);

/**
 * Queue one event. Resolves false instead of waiting when Redis is slow or down: the webhook must answer Meta within five
 * seconds, and the stored event is the source of truth (a sweeper queues what was missed).
 */
export async function enqueueSocialEvent(
  queue: JobQueue,
  job: SocialEventJob,
  timeoutMs = 1500,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      queue.add('event', job, { jobId: socialEventJobId(job.eventId), ...META_JOB_OPTIONS }),
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
