import { AutomationKind } from '@orderloop/contracts';
import { z } from 'zod';

/** The three queues. The API puts event and retry jobs on `evaluate` and `deliver`; the worker's scheduler fills the rest. */
export const QUEUES = {
  /** One repeatable job (`automation-tick`, every minute) that finds what is due. */
  tick: 'automation-tick',
  /** Rule evaluations. */
  evaluate: 'automation',
  /** One job per (notification, channel). */
  deliver: 'automation-delivery',
} as const;

export const TICK_EVERY_MS = 60_000;
export const TICK_SCHEDULER_ID = 'automation-tick';

/** Attempts, back-off and retention for every automation job: 5 tries (10 s, 20 s, 40 s, 80 s apart), done jobs kept a day, failed ones a week. */
export const AUTOMATION_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * Deterministic job ids. BullMQ refuses ':' in a custom id, so parts are joined with '__' and any ':' in a part (slot keys
 * contain them) becomes '_'. The same thing therefore always gets the same id, and adding it twice is a no-op.
 */
export function jobIdOf(...parts: (string | number)[]): string {
  return parts.map((p) => String(p).replaceAll(':', '_')).join('__');
}

/** What the API and the scheduler put on the evaluation queue: ids and slot names only, never data. Re-validated by the worker. */
export const EvaluateJob = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('scan'),
    tenantId: z.string().uuid(),
    ruleId: z.string().uuid(),
    kind: AutomationKind,
    slotKey: z.string().min(1).max(100),
    scheduledFor: z.string().datetime(),
  }),
  z.object({
    type: z.literal('neworder'),
    tenantId: z.string().uuid(),
    orderId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('retry-run'),
    tenantId: z.string().uuid(),
    runId: z.string().uuid(),
  }),
]);
export type EvaluateJob = z.infer<typeof EvaluateJob>;

export const DeliverJob = z.object({
  tenantId: z.string().uuid(),
  deliveryId: z.string().uuid(),
});
export type DeliverJob = z.infer<typeof DeliverJob>;

/** Expo reports dead devices some minutes after sending; a delayed job asks for the receipts. Ticket ids and tokens, nothing else. */
export const ReceiptsJob = z.object({
  tickets: z
    .array(z.object({ id: z.string().min(1), token: z.string().min(1) }))
    .min(1)
    .max(1000),
});
export type ReceiptsJob = z.infer<typeof ReceiptsJob>;
export const RECEIPTS_DELAY_MS = 15 * 60_000;

/** The part of a BullMQ queue the engine uses, so tests can pass a plain object. */
export interface JobQueue {
  add(
    name: string,
    data: object,
    opts?: { jobId?: string; delay?: number } & Record<string, unknown>,
  ): Promise<unknown>;
}

export interface Queues {
  evaluate: JobQueue;
  deliver: JobQueue;
}

/** One structured log line. Never holds a customer's data, a message body or a token. */
export interface LogEvent {
  level?: 'info' | 'warn' | 'error';
  event: string;
  tenantId?: string;
  ruleId?: string;
  runId?: string;
  deliveryId?: string;
  jobId?: string;
  attempt?: number;
  durationMs?: number;
  outcome?: string;
  [extra: string]: unknown;
}
export type Logger = (event: LogEvent) => void;
export const noopLogger: Logger = () => undefined;

/** The default sink: one JSON object per line on stdout (errors on stderr). */
export const jsonLogger: Logger = (event) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level: 'info', ...event });
  if (event.level === 'error' || event.level === 'warn') console.error(line);
  else console.log(line);
};
