import {
  TIKTOK_JOB_OPTIONS,
  TIKTOK_SCHEDULES,
  TikTokEventJob,
  markTikTokEventFailed,
  processTikTokEvent,
  refreshDueTikTokTokens,
  runTikTokHealthSweep,
  runTikTokSyncSweep,
  type Logger,
  type TikTokMaintenanceJob,
  type TikTokProcessDeps,
  type TikTokSyncDeps,
} from '@orderloop/automation';
import type { Database } from '@orderloop/db';

/** The slice of a BullMQ job the processors read. */
export interface TikTokJobLike {
  id?: string | undefined;
  name?: string | undefined;
  data: unknown;
  attemptsMade?: number;
  opts: { attempts?: number | undefined };
}

/**
 * The BullMQ processors of the TikTok queues, as plain functions of a job so they can be tested without Redis. The event job
 * carries ids only and is re-validated here: the worker must not trust what comes out of Redis. The maintenance jobs (catch-up
 * check, token renewal, daily health check) exist only for a live shop, so they do nothing without live dependencies.
 */
export function tiktokProcessors(deps: {
  process: TikTokProcessDeps;
  /** Present when TIKTOK_MODE=live is fully configured. */
  live?: TikTokSyncDeps | undefined;
}) {
  return {
    event: async (job: TikTokJobLike) => {
      const ref = TikTokEventJob.parse(job.data);
      await processTikTokEvent(deps.process, ref);
    },
    maintenance: async (job: TikTokJobLike) => {
      if (!deps.live) return;
      const name = job.name as TikTokMaintenanceJob;
      if (name === 'sync') await runTikTokSyncSweep(deps.live);
      else if (name === 'refresh') await refreshDueTikTokTokens(deps.live);
      else if (name === 'health') await runTikTokHealthSweep(deps.live);
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

/** ONE catch-up check, ONE token renewal scan and ONE daily health check, however many workers run (fixed scheduler ids). */
export async function registerTikTokSchedules(queue: SchedulerQueue): Promise<void> {
  for (const [name, schedule] of Object.entries(TIKTOK_SCHEDULES))
    await queue.upsertJobScheduler(
      schedule.id,
      { every: schedule.every },
      {
        name,
        data: {},
        opts: { removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } },
      },
    );
}

/** A job that ran out of retries: the event is marked failed (without its content) so it never sits `received` for ever. */
export async function onTikTokEventJobFailed(
  db: Database,
  log: Logger,
  job: TikTokJobLike | undefined,
  error: Error,
): Promise<void> {
  const attempts = job?.opts.attempts ?? TIKTOK_JOB_OPTIONS.attempts;
  const exhausted = !!job && (job.attemptsMade ?? 0) >= attempts;
  log({
    level: 'error',
    event: 'tiktok.job_failed',
    jobId: job?.id,
    outcome: exhausted ? 'exhausted' : 'will_retry',
    error: error.name,
  });
  if (!exhausted) return;
  const ref = TikTokEventJob.safeParse(job.data);
  if (ref.success) await markTikTokEventFailed(db, ref.data, 'processing_failed');
}
