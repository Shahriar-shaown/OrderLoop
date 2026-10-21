import {
  DEFAULT_PREFERENCE,
  DEFAULT_RULE_CHANNELS,
  DEFAULT_RULE_CONFIG,
  parseRuleConfig,
  type AutomationKind,
  type RuleChannels,
  type RunTrigger,
} from '@orderloop/contracts';
import { Database, isUniqueViolation, Prisma, type Tx } from '@orderloop/db';
import { roleCanReceive } from '@orderloop/domain';
import { scrubError } from './classify.js';
import { EVALUATORS, type EvalContext } from './evaluate.js';
import { AUTOMATION_JOB_OPTIONS, jobIdOf, type Logger, type Queues } from './jobs.js';

export interface EngineDeps {
  db: Database;
  queues: Queues;
  now: () => Date;
  log: Logger;
}

/** What identifies one execution of one rule. `slotKey` is the idempotency key (unique per rule). */
export interface RunTarget {
  tenantId: string;
  ruleId: string;
  kind: AutomationKind;
  slotKey: string;
  scheduledFor: Date;
  trigger: RunTrigger;
  /** NEW_ORDER event jobs: the order to announce. */
  orderId?: string | undefined;
}

export interface JobInfo {
  jobId?: string | undefined;
  /** 1-based attempt of the queue job. Above 1 the queue is redelivering: the previous attempt ended, so a `running` run is ours. */
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
}

export interface RunRecord {
  id: string;
  tenantId: string;
  ruleId: string;
  kind: AutomationKind;
  slotKey: string;
  trigger: RunTrigger;
  scheduledFor: Date;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
  attempts: number;
  error: string | null;
  createdCount: number;
  skippedCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export type RunOutcome =
  | { outcome: 'executed'; run: RunRecord }
  /** The slot already ran (or is running elsewhere): nothing was done. */
  | { outcome: 'duplicate'; run: RunRecord }
  /** No such rule, or it is switched off: nothing was done and no run exists. */
  | { outcome: 'disabled'; run: null };

export interface RuleRecord {
  id: string;
  tenantId: string;
  kind: AutomationKind;
  enabled: boolean;
  config: Record<string, unknown>;
  channels: RuleChannels;
  enabledAt: Date | null;
}

export function mergeChannels(stored: unknown): RuleChannels {
  return { ...DEFAULT_RULE_CHANNELS, ...((stored ?? {}) as Partial<RuleChannels>) };
}

export function toRuleRecord(row: {
  id: string;
  tenantId: string;
  kind: AutomationKind;
  enabled: boolean;
  config: unknown;
  channels: unknown;
  enabledAt: Date | null;
}): RuleRecord {
  const parsed = parseRuleConfig(row.kind, row.config);
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    enabled: row.enabled,
    // a config that no longer validates falls back to the defaults rather than stopping the rule
    config: parsed.ok ? parsed.config : { ...DEFAULT_RULE_CONFIG[row.kind] },
    channels: mergeChannels(row.channels),
    enabledAt: row.enabledAt,
  };
}

export const toRunRecord = (r: {
  id: string;
  tenantId: string;
  ruleId: string;
  kind: AutomationKind;
  slotKey: string;
  trigger: RunTrigger;
  scheduledFor: Date;
  status: RunRecord['status'];
  attempts: number;
  error: string | null;
  createdCount: number;
  skippedCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}): RunRecord => ({ ...r });

const MAX_ERROR = 300;

// ---- claiming the slot ------------------------------------------------------------------------------------------------

/**
 * Take the run for a slot, or find out it is not ours to take.
 *  - Nobody has run it: insert it as `running` (the unique (rule_id, slot_key) makes this a race with one winner).
 *  - It is `succeeded` or `skipped`: duplicate, do nothing.
 *  - It is `failed` or `queued` (a retry): take it over.
 *  - It is `running`: another worker may be on it, so leave it, unless the queue says it is redelivering (`reclaim`): then the
 *    previous attempt is over (crashed or stalled) and the run is ours.
 */
export async function claimRun(
  deps: EngineDeps,
  target: RunTarget,
  reclaim: boolean,
): Promise<{ run: RunRecord; execute: boolean }> {
  const now = deps.now();
  const ctx = { tenantId: target.tenantId };
  try {
    const created = await deps.db.withContext(ctx, (tx) =>
      tx.automationRun.create({
        data: {
          tenantId: target.tenantId,
          ruleId: target.ruleId,
          kind: target.kind,
          slotKey: target.slotKey,
          trigger: target.trigger,
          scheduledFor: target.scheduledFor,
          status: 'running',
          attempts: 1,
          startedAt: now,
        },
      }),
    );
    return { run: toRunRecord(created), execute: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  return deps.db.withContext(ctx, async (tx) => {
    const existing = await tx.automationRun.findUniqueOrThrow({
      where: { ruleId_slotKey: { ruleId: target.ruleId, slotKey: target.slotKey } },
    });
    const takeable: ('failed' | 'queued' | 'running')[] = reclaim
      ? ['failed', 'queued', 'running']
      : ['failed', 'queued'];
    const taken = await tx.automationRun.updateMany({
      where: { id: existing.id, status: { in: takeable } },
      data: {
        status: 'running',
        attempts: { increment: 1 },
        startedAt: now,
        finishedAt: null,
        error: null,
      },
    });
    const fresh = await tx.automationRun.findUniqueOrThrow({ where: { id: existing.id } });
    return { run: toRunRecord(fresh), execute: taken.count === 1 };
  });
}

// ---- who is told ------------------------------------------------------------------------------------------------------

export interface Recipient {
  userId: string;
  channels: RuleChannels;
}

/**
 * Active members of THIS business whose role holds the permission for the topic, and the channels each of them gets:
 * what the rule switches on, narrowed by the person's own preferences. Sms and whatsapp need the person's own recorded
 * consent (not revoked) and a number; they have no preference of their own, because consent is the preference.
 * A person left with no channel at all is not a recipient.
 */
export async function resolveRecipients(
  tx: Tx,
  tenantId: string,
  kind: AutomationKind,
  rule: RuleChannels,
  providers: { sms: boolean; whatsapp: boolean },
): Promise<{ recipients: Recipient[]; excluded: number }> {
  const members = await tx.membership.findMany({
    where: { tenantId },
    select: { userId: true, role: true, user: { select: { disabledAt: true } } },
  });
  const eligible = members.filter((m) => !m.user.disabledAt && roleCanReceive(m.role, kind));
  if (eligible.length === 0) return { recipients: [], excluded: 0 };
  const userIds = eligible.map((m) => m.userId);
  const [prefs, consents] = await Promise.all([
    tx.notificationPreference.findMany({ where: { tenantId, kind, userId: { in: userIds } } }),
    tx.messagingConsent.findMany({
      where: { tenantId, userId: { in: userIds }, revokedAt: null },
      select: { userId: true, channel: true },
    }),
  ]);
  const prefOf = new Map(prefs.map((p) => [p.userId, p]));
  const consentOf = new Set(consents.map((c) => `${c.userId}:${c.channel}`));
  const recipients: Recipient[] = [];
  let excluded = 0;
  for (const m of eligible) {
    const p = prefOf.get(m.userId);
    const channels: RuleChannels = {
      inApp: rule.inApp && (p?.inApp ?? DEFAULT_PREFERENCE.inApp),
      push: rule.push && (p?.push ?? DEFAULT_PREFERENCE.push),
      email: rule.email && (p?.email ?? DEFAULT_PREFERENCE.email),
      sms: rule.sms && providers.sms && consentOf.has(`${m.userId}:sms`),
      whatsapp: rule.whatsapp && providers.whatsapp && consentOf.has(`${m.userId}:whatsapp`),
    };
    if (Object.values(channels).some(Boolean)) recipients.push({ userId: m.userId, channels });
    else excluded += 1;
  }
  return { recipients, excluded };
}

// ---- writing notifications --------------------------------------------------------------------------------------------

/**
 * One notification per recipient and one delivery per channel, written together. Creating one that exists (same
 * recipient and dedupe key) is skipped by the database, and its deliveries were created in the same transaction as it, so a
 * repeat of anything never makes a second notification or a second delivery.
 */
async function writeNotifications(
  tx: Tx,
  args: {
    tenantId: string;
    runId: string;
    kind: AutomationKind;
    title: string;
    body: string;
    data: Prisma.InputJsonObject;
    dedupeKey: string;
    recipients: Recipient[];
    now: Date;
  },
): Promise<{ created: number; skipped: number }> {
  const created = await tx.notification.createManyAndReturn({
    data: args.recipients.map((r) => ({
      tenantId: args.tenantId,
      userId: r.userId,
      runId: args.runId,
      kind: args.kind,
      title: args.title,
      body: args.body,
      data: args.data,
      dedupeKey: args.dedupeKey,
      inApp: r.channels.inApp,
      createdAt: args.now,
    })),
    skipDuplicates: true,
    select: { id: true, userId: true },
  });
  const channelsOf = new Map(args.recipients.map((r) => [r.userId, r.channels]));
  const deliveries: Prisma.NotificationDeliveryCreateManyInput[] = [];
  for (const n of created) {
    const c = channelsOf.get(n.userId)!;
    const base = { tenantId: args.tenantId, notificationId: n.id, createdAt: args.now };
    if (c.inApp) deliveries.push({ ...base, channel: 'in_app', status: 'sent', sentAt: args.now });
    for (const channel of ['push', 'email', 'sms', 'whatsapp'] as const)
      if (c[channel]) deliveries.push({ ...base, channel, status: 'pending' });
  }
  if (deliveries.length)
    await tx.notificationDelivery.createMany({ data: deliveries, skipDuplicates: true });
  return { created: created.length, skipped: args.recipients.length - created.length };
}

// ---- one evaluation ---------------------------------------------------------------------------------------------------

interface ComputeResult {
  status: 'succeeded' | 'skipped';
  created: number;
  skipped: number;
}

/**
 * The whole decision in ONE transaction: who is told, what is new (claiming the subjects), and the notifications and
 * deliveries that announce it. Either all of it commits or none, so a crash can never leave a subject marked as announced
 * with nobody told.
 */
async function compute(
  deps: EngineDeps,
  tx: Tx,
  rule: RuleRecord,
  run: RunRecord,
  target: RunTarget,
  providers: { sms: boolean; whatsapp: boolean },
): Promise<ComputeResult> {
  const now = deps.now();
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: rule.tenantId },
    select: { timezone: true, currency: true },
  });
  const { recipients, excluded } = await resolveRecipients(
    tx,
    rule.tenantId,
    rule.kind,
    rule.channels,
    providers,
  );
  // Nobody to tell: do not claim anything, so whoever becomes a recipient later still hears about it.
  if (recipients.length === 0) return { status: 'skipped', created: 0, skipped: excluded };

  const ctx: EvalContext = {
    tx,
    tenantId: rule.tenantId,
    ruleId: rule.id,
    runId: run.id,
    kind: rule.kind,
    config: rule.config,
    now,
    timezone: tenant.timezone,
    currency: tenant.currency,
    enabledAt: rule.enabledAt,
    slotKey: run.slotKey,
    orderId: target.orderId,
  };
  const found = await EVALUATORS[rule.kind](ctx);
  if (!found) return { status: 'succeeded', created: 0, skipped: excluded };
  const written = await writeNotifications(tx, {
    tenantId: rule.tenantId,
    runId: run.id,
    kind: rule.kind,
    title: found.built.title,
    body: found.built.body,
    data: found.built.data as Prisma.InputJsonObject,
    dedupeKey: found.dedupeKey,
    recipients,
    now,
  });
  return { status: 'succeeded', created: written.created, skipped: written.skipped + excluded };
}

/** Queue every delivery of this run that still waits. Deterministic job ids make queueing twice harmless. */
export async function enqueueRunDeliveries(
  deps: EngineDeps,
  tenantId: string,
  runId: string,
): Promise<number> {
  const pending = await deps.db.withContext({ tenantId }, (tx) =>
    tx.notificationDelivery.findMany({
      where: {
        tenantId,
        status: 'pending',
        attempts: 0,
        channel: { not: 'in_app' },
        notification: { runId },
      },
      select: { id: true },
    }),
  );
  for (const d of pending)
    await deps.queues.deliver.add(
      'deliver',
      { tenantId, deliveryId: d.id },
      { jobId: jobIdOf('delivery', d.id), ...AUTOMATION_JOB_OPTIONS },
    );
  return pending.length;
}

/**
 * Evaluate one rule for one slot. Safe to call twice, concurrently, or after a crash:
 *  (a) the run row is claimed through its unique slot, so a duplicate does nothing and a failed run resumes;
 *  (b) notifications are written with ON CONFLICT DO NOTHING on their dedupe key, and subjects are claimed atomically;
 *  (c) deliveries are queued under deterministic ids.
 * Throws when the evaluation fails (after recording the failure on the run), so the queue retries it.
 */
export async function executeRule(
  deps: EngineDeps & { providers: { sms: boolean; whatsapp: boolean } },
  target: RunTarget,
  job: JobInfo = {},
): Promise<RunOutcome> {
  const started = Date.now();
  const tenantCtx = { tenantId: target.tenantId };
  const ruleRow = await deps.db.withContext(tenantCtx, (tx) =>
    tx.automationRule.findFirst({ where: { id: target.ruleId, tenantId: target.tenantId } }),
  );
  if (!ruleRow || !ruleRow.enabled) {
    deps.log({
      event: 'automation.run',
      tenantId: target.tenantId,
      ruleId: target.ruleId,
      jobId: job.jobId,
      attempt: job.attempt,
      outcome: 'rule_disabled',
      durationMs: Date.now() - started,
    });
    return { outcome: 'disabled', run: null };
  }
  const rule = toRuleRecord(ruleRow);
  const { run, execute } = await claimRun(deps, target, (job.attempt ?? 1) > 1);
  const logBase = {
    event: 'automation.run',
    tenantId: target.tenantId,
    ruleId: rule.id,
    runId: run.id,
    kind: rule.kind,
    trigger: target.trigger,
    jobId: job.jobId,
    attempt: job.attempt,
  };
  if (!execute) {
    deps.log({ ...logBase, outcome: `duplicate_${run.status}`, durationMs: Date.now() - started });
    return { outcome: 'duplicate', run };
  }
  try {
    const result = await deps.db.withContext(
      tenantCtx,
      (tx) => compute(deps, tx, rule, run, target, deps.providers),
      { timeout: 60_000, maxWait: 10_000 },
    );
    const queued = await enqueueRunDeliveries(deps, target.tenantId, run.id);
    const finished = await deps.db.withContext(tenantCtx, (tx) =>
      tx.automationRun.update({
        where: { id: run.id },
        data: {
          status: result.status,
          createdCount: result.created,
          skippedCount: result.skipped,
          finishedAt: deps.now(),
          error: null,
        },
      }),
    );
    deps.log({
      ...logBase,
      outcome: result.status,
      created: result.created,
      skipped: result.skipped,
      deliveriesQueued: queued,
      durationMs: Date.now() - started,
    });
    return { outcome: 'executed', run: toRunRecord(finished) };
  } catch (error) {
    const message = scrubError(error).slice(0, MAX_ERROR);
    await deps.db
      .withContext(tenantCtx, (tx) =>
        tx.automationRun.update({
          where: { id: run.id },
          data: { status: 'failed', error: message, finishedAt: deps.now() },
        }),
      )
      .catch(() => undefined);
    deps.log({
      ...logBase,
      level: 'error',
      outcome: 'failed',
      error: message,
      durationMs: Date.now() - started,
    });
    throw error;
  }
}

/** Run an existing run again (the manual or queued retry of a failed run), under its own slot. */
export async function executeExistingRun(
  deps: EngineDeps & { providers: { sms: boolean; whatsapp: boolean } },
  tenantId: string,
  runId: string,
  job: JobInfo = {},
): Promise<RunOutcome> {
  const run = await deps.db.withContext({ tenantId }, (tx) =>
    tx.automationRun.findFirst({ where: { id: runId, tenantId } }),
  );
  if (!run) return { outcome: 'disabled', run: null };
  return executeRule(
    deps,
    {
      tenantId,
      ruleId: run.ruleId,
      kind: run.kind,
      slotKey: run.slotKey,
      scheduledFor: run.scheduledFor,
      trigger: run.trigger,
      // a NEW_ORDER event run keeps its order in the slot name
      orderId: run.slotKey.startsWith('neworder:')
        ? run.slotKey.slice('neworder:'.length)
        : undefined,
    },
    job,
  );
}
