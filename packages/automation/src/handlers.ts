import { randomUUID } from 'node:crypto';
import type { AutomationKind } from '@orderloop/contracts';
import { currentReportSlot, isReportKind, isValidTimeZone } from '@orderloop/domain';
import {
  executeExistingRun,
  executeRule,
  toRunRecord,
  type EngineDeps,
  type JobInfo,
  type RunOutcome,
  type RunRecord,
} from './engine.js';
import {
  AUTOMATION_JOB_OPTIONS,
  DeliverJob,
  EvaluateJob,
  ReceiptsJob,
  jobIdOf,
  type JobQueue,
} from './jobs.js';
import { processDelivery, processReceipts, type DeliverDeps, type DeliverInfo } from './deliver.js';

export type EvaluateDeps = EngineDeps & { providers: { sms: boolean; whatsapp: boolean } };

/** The worker's evaluation job. The data comes out of Redis, so it is validated again before anything is trusted. */
export async function handleEvaluateJob(
  deps: EvaluateDeps,
  rawData: unknown,
  info: JobInfo = {},
): Promise<RunOutcome> {
  const data = EvaluateJob.parse(rawData);
  if (data.type === 'scan')
    return executeRule(
      deps,
      {
        tenantId: data.tenantId,
        ruleId: data.ruleId,
        kind: data.kind,
        slotKey: data.slotKey,
        scheduledFor: new Date(data.scheduledFor),
        trigger: 'scheduled',
      },
      info,
    );
  if (data.type === 'retry-run') return executeExistingRun(deps, data.tenantId, data.runId, info);
  // neworder
  const rule = await deps.db.withContext({ tenantId: data.tenantId }, (tx) =>
    tx.automationRule.findFirst({
      where: { tenantId: data.tenantId, kind: 'NEW_ORDER', enabled: true },
      select: { id: true },
    }),
  );
  if (!rule) return { outcome: 'disabled', run: null };
  return executeRule(
    deps,
    {
      tenantId: data.tenantId,
      ruleId: rule.id,
      kind: 'NEW_ORDER',
      slotKey: `neworder:${data.orderId}`,
      scheduledFor: deps.now(),
      trigger: 'event',
      orderId: data.orderId,
    },
    info,
  );
}

export const handleDeliverJob = (deps: DeliverDeps, rawData: unknown, info: DeliverInfo = {}) =>
  processDelivery(deps, DeliverJob.parse(rawData), info);

export const handleReceiptsJob = (
  deps: Pick<DeliverDeps, 'db' | 'providers' | 'log'>,
  rawData: unknown,
) => processReceipts(deps, ReceiptsJob.parse(rawData));

// ---- used by the API --------------------------------------------------------------------------------------------------

/**
 * After an order is created: ask for a NEW_ORDER evaluation of that order, under the deterministic id
 * `neworder__<orderId>`. A failure to queue never fails the order (the five-minute catch-up scan announces it), so this
 * returns whether it was queued instead of throwing.
 */
export async function enqueueNewOrder(
  queue: JobQueue,
  tenantId: string,
  orderId: string,
): Promise<boolean> {
  try {
    await queue.add(
      'evaluate',
      { type: 'neworder', tenantId, orderId },
      { jobId: jobIdOf('neworder', orderId), ...AUTOMATION_JOB_OPTIONS },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Evaluate a rule now, for the caller's business, through the same code and the same de-duplication as the scheduler.
 *  - Scans use a fresh slot (`manual:<key>`), so asking again evaluates again; what was already announced stays announced
 *    (episode state), so a second trigger, even a concurrent one, creates nothing twice. The same idempotency key returns the first run.
 *  - Reports use the natural slot of today / this week (`daily:2026-03-29`): running a report by hand IS that day's report, and
 *    the scheduler will not send it again.
 */
export async function runRuleNow(
  deps: EvaluateDeps,
  args: {
    tenantId: string;
    ruleId: string;
    kind: AutomationKind;
    timezone: string;
    idempotencyKey?: string | undefined;
  },
): Promise<RunOutcome> {
  const now = deps.now();
  let slotKey: string;
  if (isReportKind(args.kind) && isValidTimeZone(args.timezone))
    slotKey = currentReportSlot(
      now,
      args.timezone,
      args.kind as 'DAILY_REPORT' | 'WEEKLY_REPORT',
    ).slotKey;
  else slotKey = `manual:${args.idempotencyKey ?? randomUUID()}`;
  const target = {
    tenantId: args.tenantId,
    ruleId: args.ruleId,
    kind: args.kind,
    slotKey,
    scheduledFor: now,
    trigger: 'manual' as const,
  };
  try {
    return await executeRule(deps, target);
  } catch (error) {
    // The failure is on the run row (status failed, with its error): that is the answer, not an HTTP 500.
    const run = await deps.db.withContext({ tenantId: args.tenantId }, (tx) =>
      tx.automationRun.findUnique({ where: { ruleId_slotKey: { ruleId: args.ruleId, slotKey } } }),
    );
    if (run) return { outcome: 'executed', run: toRunRecord(run) };
    throw error;
  }
}

/**
 * Queue a failed run again. Idempotent: only a `failed` run moves (to `queued`); a second call finds it already queued,
 * running or done and changes nothing, so the queue gets one job per failure.
 */
export async function retryRun(
  deps: Pick<EngineDeps, 'db' | 'queues'>,
  tenantId: string,
  runId: string,
): Promise<RunRecord | null> {
  const ctx = { tenantId };
  const moved = await deps.db.withContext(ctx, async (tx) => {
    const run = await tx.automationRun.findFirst({ where: { id: runId, tenantId } });
    if (!run) return null;
    const changed = await tx.automationRun.updateMany({
      where: { id: runId, tenantId, status: 'failed' },
      data: { status: 'queued', error: null, finishedAt: null },
    });
    const fresh = await tx.automationRun.findUniqueOrThrow({ where: { id: runId } });
    return { run: fresh, changed: changed.count === 1 };
  });
  if (!moved) return null;
  if (moved.changed)
    await deps.queues.evaluate.add(
      'evaluate',
      { type: 'retry-run', tenantId, runId },
      { jobId: jobIdOf('retry-run', runId, moved.run.attempts), ...AUTOMATION_JOB_OPTIONS },
    );
  return toRunRecord(moved.run);
}

/**
 * Queue a failed delivery again. Idempotent, and it can never make a second send of a sent one: only `failed` moves to
 * `pending`; `sent` and `skipped` stay as they are, and the worker's claim only takes `pending` or `failed`.
 */
export async function retryDelivery(
  deps: Pick<EngineDeps, 'db' | 'queues'>,
  tenantId: string,
  deliveryId: string,
): Promise<{ id: string; status: string; attempts: number } | null> {
  const ctx = { tenantId };
  const moved = await deps.db.withContext(ctx, async (tx) => {
    const found = await tx.notificationDelivery.findFirst({ where: { id: deliveryId, tenantId } });
    if (!found) return null;
    const changed = await tx.notificationDelivery.updateMany({
      where: { id: deliveryId, tenantId, status: 'failed', channel: { not: 'in_app' } },
      data: { status: 'pending', claimedAt: null },
    });
    const fresh = await tx.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    return { delivery: fresh, changed: changed.count === 1 };
  });
  if (!moved) return null;
  if (moved.changed)
    await deps.queues.deliver.add(
      'deliver',
      { tenantId, deliveryId },
      {
        jobId: jobIdOf('delivery', deliveryId, 'retry', moved.delivery.attempts),
        ...AUTOMATION_JOB_OPTIONS,
      },
    );
  return {
    id: moved.delivery.id,
    status: moved.delivery.status,
    attempts: moved.delivery.attempts,
  };
}
