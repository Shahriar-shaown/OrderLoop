import {
  AUTOMATION_JOB_OPTIONS,
  QUEUES,
  TICK_EVERY_MS,
  TICK_SCHEDULER_ID,
  handleDeliverJob,
  handleEvaluateJob,
  handleReceiptsJob,
  runAutomationTick,
  type DeliverDeps,
  type EvaluateDeps,
  type Logger,
  type TickDeps,
} from '@orderloop/automation';

/** The slice of a BullMQ job the processors read. */
export interface JobLike {
  id?: string | undefined;
  name?: string | undefined;
  data: unknown;
  attemptsStarted: number;
  opts: { attempts?: number | undefined };
}

export interface AutomationWiring {
  evaluate: EvaluateDeps;
  deliver: DeliverDeps;
  tick: TickDeps;
}

/**
 * The BullMQ processors for the three automation queues, as plain functions of a job, so they can be tested without Redis.
 * `attemptsStarted > 1` tells the engine the queue is redelivering (the previous attempt crashed, stalled or threw), which is
 * what lets it take over a run or a delivery that an earlier attempt left claimed.
 */
export function automationProcessors(w: AutomationWiring) {
  const info = (job: JobLike) => ({
    jobId: job.id,
    attempt: job.attemptsStarted,
    maxAttempts: job.opts.attempts ?? AUTOMATION_JOB_OPTIONS.attempts,
  });
  return {
    tick: async () => {
      await runAutomationTick(w.tick);
    },
    evaluate: async (job: JobLike) => {
      await handleEvaluateJob(w.evaluate, job.data, info(job));
    },
    deliver: async (job: JobLike) => {
      // `receipts` jobs share the delivery queue (they are delayed follow-ups of a push).
      if (job.name === 'receipts') {
        await handleReceiptsJob(w.deliver, job.data);
        return;
      }
      await handleDeliverJob(w.deliver, job.data, info(job));
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

/**
 * Register the ONE repeatable tick. `upsertJobScheduler` is idempotent by scheduler id, so any number of workers can call it
 * at start-up and there is still a single tick every minute (no cron per tenant, no in-process timers).
 */
export async function registerTick(queue: SchedulerQueue): Promise<void> {
  await queue.upsertJobScheduler(
    TICK_SCHEDULER_ID,
    { every: TICK_EVERY_MS },
    {
      name: 'tick',
      data: {},
      opts: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 24 * 3600 } },
    },
  );
}

export const WORKER_QUEUES = QUEUES;

/** A failed job, logged without its data: ids are fine, but the log line never holds a body or a token. */
export function logFailedJob(
  log: Logger,
  queue: string,
  job: JobLike | undefined,
  error: Error,
): void {
  const attempts = job?.opts.attempts ?? AUTOMATION_JOB_OPTIONS.attempts;
  log({
    level: 'error',
    event: 'automation.job_failed',
    queue,
    jobId: job?.id,
    attempt: job?.attemptsStarted,
    outcome: job && job.attemptsStarted >= attempts ? 'exhausted' : 'will_retry',
    error: error.name,
  });
}
