import {
  HEALTH_EVERY_MS,
  HEALTH_SCHEDULER_ID,
  META_JOB_OPTIONS,
  SocialEventJob,
  markSocialEventFailed,
  processSocialEvent,
  runHealthSweep,
  type HealthDeps,
  type Logger,
  type ProcessDeps,
} from '@orderloop/automation';
import type { Database } from '@orderloop/db';

/** The slice of a BullMQ job the processors read. */
export interface MetaJobLike {
  id?: string | undefined;
  data: unknown;
  attemptsMade?: number;
  opts: { attempts?: number | undefined };
}

/**
 * The BullMQ processors of the Meta queues, as plain functions of a job so they can be tested without Redis.
 * The job carries ids only and is re-validated here: the worker must not trust what comes out of Redis.
 */
export function metaProcessors(deps: { process: ProcessDeps; health?: HealthDeps | undefined }) {
  return {
    event: async (job: MetaJobLike) => {
      const ref = SocialEventJob.parse(job.data);
      await processSocialEvent(deps.process, ref);
    },
    /** The daily health sweep. Without a Meta app configured there is nothing real to check. */
    health: async () => {
      if (deps.health) await runHealthSweep(deps.health);
    },
  };
}

export interface SchedulerQueue {
  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; data: object; opts: object },
  ): Promise<unknown>;
}

/** ONE daily health check, however many workers run (the scheduler is upserted by a fixed id). */
export async function registerHealthSchedule(queue: SchedulerQueue): Promise<void> {
  await queue.upsertJobScheduler(
    HEALTH_SCHEDULER_ID,
    { every: HEALTH_EVERY_MS },
    {
      name: 'health',
      data: {},
      opts: { removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } },
    },
  );
}

/** A job that ran out of retries: the event is marked failed (without its content) so it never sits `received` for ever. */
export async function onEventJobFailed(
  db: Database,
  log: Logger,
  job: MetaJobLike | undefined,
  error: Error,
): Promise<void> {
  const attempts = job?.opts.attempts ?? META_JOB_OPTIONS.attempts;
  const exhausted = !!job && (job.attemptsMade ?? 0) >= attempts;
  log({
    level: 'error',
    event: 'meta.job_failed',
    jobId: job?.id,
    outcome: exhausted ? 'exhausted' : 'will_retry',
    error: error.name,
  });
  if (!exhausted) return;
  const ref = SocialEventJob.safeParse(job.data);
  if (ref.success) await markSocialEventFailed(db, ref.data, 'processing_failed');
}
