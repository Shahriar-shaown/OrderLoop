import { parseRuleConfig, type AutomationKind } from '@orderloop/contracts';
import type { Database } from '@orderloop/db';
import { dueSlot, isReportKind, isValidTimeZone, scanSlot } from '@orderloop/domain';
import { AUTOMATION_JOB_OPTIONS, jobIdOf, type Logger, type Queues } from './jobs.js';

export interface TickDeps {
  db: Database;
  queues: Queues;
  now: () => Date;
  log: Logger;
}

/** How long a delivery may sit `pending` with no job before the tick queues it again. */
export const STALE_DELIVERY_SECONDS = 60;

/**
 * The scheduler's one job, every minute, safe with any number of workers. It does not evaluate anything: it finds what is
 * due and queues an evaluation under a deterministic id (`<ruleId>__<slotKey>`), so queueing the same slot from two
 * workers, or again a minute later, is a no-op.
 *  - scan kinds: the current five-minute bucket (`scan:20261025T1430Z`);
 *  - report kinds: `dueSlot()` in the business's own time zone (`daily:2026-03-29`, `weekly:2026-W13`).
 * It also re-queues deliveries that were saved but never queued.
 */
export async function runAutomationTick(
  deps: TickDeps,
): Promise<{ rules: number; queued: number; requeuedDeliveries: number }> {
  const now = deps.now();
  let after: string | null = null;
  let rules = 0;
  let queued = 0;
  for (;;) {
    const page = await deps.db.enabledAutomationRules(after, 500);
    if (page.length === 0) break;
    for (const rule of page) {
      rules += 1;
      try {
        const slot = slotFor(rule.kind, rule.config, rule.timezone, now);
        if (!slot) continue;
        await deps.queues.evaluate.add(
          'evaluate',
          {
            type: 'scan',
            tenantId: rule.tenantId,
            ruleId: rule.id,
            kind: rule.kind,
            slotKey: slot.slotKey,
            scheduledFor: slot.scheduledFor.toISOString(),
          },
          { jobId: jobIdOf(rule.id, slot.slotKey), ...AUTOMATION_JOB_OPTIONS },
        );
        queued += 1;
      } catch (error) {
        deps.log({
          level: 'error',
          event: 'automation.tick_rule_failed',
          tenantId: rule.tenantId,
          ruleId: rule.id,
          error: error instanceof Error ? error.message.slice(0, 200) : 'error',
        });
      }
    }
    after = page.at(-1)!.id;
    if (page.length < 500) break;
  }
  const requeuedDeliveries = await sweepPendingDeliveries(deps);
  deps.log({ event: 'automation.tick', rules, queued, requeuedDeliveries });
  return { rules, queued, requeuedDeliveries };
}

/** The slot to queue for a rule right now, or null when nothing is due. */
export function slotFor(
  kind: AutomationKind,
  config: Record<string, unknown>,
  timezone: string,
  now: Date,
): { slotKey: string; scheduledFor: Date } | null {
  if (!isReportKind(kind)) return scanSlot(now);
  const parsed = parseRuleConfig(kind, config);
  if (!parsed.ok || !isValidTimeZone(timezone)) return null;
  const localTime = String(parsed.config.localTime);
  const due =
    kind === 'DAILY_REPORT'
      ? dueSlot(now, timezone, { kind, localTime })
      : dueSlot(now, timezone, {
          kind: 'WEEKLY_REPORT',
          localTime,
          weekday: Number(parsed.config.weekday),
        });
  return due ? { slotKey: due.slotKey, scheduledFor: due.scheduledFor } : null;
}

/** Deliveries committed as `pending` that no job picked up (the process died between the commit and the queue). */
export async function sweepPendingDeliveries(deps: TickDeps): Promise<number> {
  const stale = await deps.db.stalePendingDeliveries(STALE_DELIVERY_SECONDS, 200);
  for (const d of stale)
    await deps.queues.deliver.add(
      'deliver',
      { tenantId: d.tenantId, deliveryId: d.id },
      { jobId: jobIdOf('delivery', d.id), ...AUTOMATION_JOB_OPTIONS },
    );
  return stale.length;
}
