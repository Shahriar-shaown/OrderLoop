import type {
  AutomationKind,
  AutomationRule,
  Delivery,
  MessagingConsent,
  Notification,
  Run,
} from '@orderloop/contracts';
import { AUTOMATION_KINDS, DEFAULT_RULE_CHANNELS, DEFAULT_RULE_CONFIG } from '@orderloop/contracts';
import { mergeChannels, toRuleRecord, type RunRecord } from '@orderloop/automation';
import { RECIPIENT_PERMISSION } from '@orderloop/domain';

export const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const toRun = (r: RunRecord): Run => ({
  id: r.id,
  ruleId: r.ruleId,
  kind: r.kind,
  slotKey: r.slotKey,
  trigger: r.trigger,
  scheduledFor: r.scheduledFor.toISOString(),
  status: r.status,
  attempts: r.attempts,
  error: r.error,
  createdCount: r.createdCount,
  skippedCount: r.skippedCount,
  startedAt: iso(r.startedAt),
  finishedAt: iso(r.finishedAt),
  createdAt: r.createdAt.toISOString(),
});

type RuleRow = Parameters<typeof toRuleRecord>[0] & { updatedAt: Date };

export function toRule(
  kind: AutomationKind,
  row: RuleRow | undefined,
  lastRun: RunRecord | null,
): AutomationRule {
  if (!row)
    return {
      kind,
      configured: false,
      enabled: false,
      config: { ...DEFAULT_RULE_CONFIG[kind] },
      channels: { ...DEFAULT_RULE_CHANNELS },
      recipientPermission: RECIPIENT_PERMISSION[kind] as AutomationRule['recipientPermission'],
      updatedAt: null,
      lastRun: lastRun ? toRun(lastRun) : null,
    };
  const rec = toRuleRecord(row);
  return {
    kind,
    configured: true,
    enabled: rec.enabled,
    config: rec.config,
    channels: mergeChannels(rec.channels),
    recipientPermission: RECIPIENT_PERMISSION[kind] as AutomationRule['recipientPermission'],
    updatedAt: row.updatedAt.toISOString(),
    lastRun: lastRun ? toRun(lastRun) : null,
  };
}

export const toNotification = (n: {
  id: string;
  kind: AutomationKind;
  title: string;
  body: string;
  data: unknown;
  createdAt: Date;
  readAt: Date | null;
}): Notification => ({
  id: n.id,
  kind: n.kind,
  title: n.title,
  body: n.body,
  data: (n.data ?? {}) as Record<string, unknown>,
  createdAt: n.createdAt.toISOString(),
  readAt: iso(n.readAt),
});

export const toDelivery = (d: {
  id: string;
  notificationId: string;
  channel: Delivery['channel'];
  status: Delivery['status'];
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
  notification: { kind: AutomationKind; userId: string };
}): Delivery => ({
  id: d.id,
  notificationId: d.notificationId,
  kind: d.notification.kind,
  recipientUserId: d.notification.userId,
  channel: d.channel,
  status: d.status,
  attempts: d.attempts,
  lastError: d.lastError,
  sentAt: iso(d.sentAt),
  createdAt: d.createdAt.toISOString(),
});

export const toConsent = (
  channel: MessagingConsent['channel'],
  configured: boolean,
  row: { phone: string; grantedAt: Date; revokedAt: Date | null } | undefined,
): MessagingConsent => ({
  channel,
  configured,
  granted: Boolean(row && !row.revokedAt),
  phone: row ? row.phone : null,
  grantedAt: row ? row.grantedAt.toISOString() : null,
  revokedAt: row ? iso(row.revokedAt) : null,
});

export { AUTOMATION_KINDS };
