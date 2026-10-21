import { z } from 'zod';
import { Uuid } from './auth.js';
import { IdempotencyKey } from './idempotency.js';

// ---- vocabulary -------------------------------------------------------------------------------------------------------

export const AUTOMATION_KINDS = [
  'LOW_STOCK',
  'NEW_ORDER',
  'UNCONFIRMED_ORDER',
  'DELAYED_ORDER',
  'COD_DISCREPANCY',
  'DAILY_REPORT',
  'WEEKLY_REPORT',
] as const;
export const AutomationKind = z.enum(AUTOMATION_KINDS);
export type AutomationKind = z.infer<typeof AutomationKind>;

/** `in_app` is the notification itself; the others are delivered by the worker, one delivery row per (notification, channel). */
export const NOTIFICATION_CHANNELS = ['in_app', 'push', 'email', 'sms', 'whatsapp'] as const;
export const NotificationChannel = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

export const MessagingChannel = z.enum(['sms', 'whatsapp']);
export type MessagingChannel = z.infer<typeof MessagingChannel>;

export const DeliveryStatus = z.enum(['pending', 'sent', 'failed', 'skipped']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

export const RunStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'skipped']);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunTrigger = z.enum(['scheduled', 'event', 'manual', 'retry']);
export type RunTrigger = z.infer<typeof RunTrigger>;

// ---- rule configuration (one schema per kind, validated as a discriminated union) -------------------------------------

/** 24-hour local time, `HH:mm`. */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm');

export const MAX_UNCONFIRMED_REMINDERS = 3;

export const LowStockConfig = z
  .object({
    kind: z.literal('LOW_STOCK'),
    /** `reorder_point`: each variant's own threshold (0 = that variant never alerts). `fixed`: one threshold for every variant. */
    basis: z.enum(['reorder_point', 'fixed']),
    fixedQuantity: z.number().int().min(0).max(1_000_000).optional(),
    /** Also alert for variants that are completely out of stock (otherwise only "running low", above zero). */
    includeZeroStock: z.boolean(),
  })
  .superRefine((c, ctx) => {
    if (c.basis === 'fixed' && c.fixedQuantity === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['fixedQuantity'],
        message: 'Required when basis is fixed',
      });
  });
export const NewOrderConfig = z.object({ kind: z.literal('NEW_ORDER') });
export const UnconfirmedConfig = z.object({
  kind: z.literal('UNCONFIRMED_ORDER'),
  /** Minutes an order may wait in pending_confirmation before the first reminder. */
  afterMinutes: z.number().int().min(5).max(10080),
  /** Remind again this often (at most 3 notifications per order in total). Omit for a single reminder. */
  repeatEveryMinutes: z.number().int().min(5).max(10080).optional(),
});
export const DelayedConfig = z.object({
  kind: z.literal('DELAYED_ORDER'),
  /** Hours since the order was confirmed (not yet handed to a courier) or shipped (not yet delivered). */
  afterHours: z.number().int().min(1).max(720),
});
export const CodDiscrepancyConfig = z.object({
  kind: z.literal('COD_DISCREPANCY'),
  /** Ignore discrepancies whose difference is smaller than this (paisa). */
  minAmountMinor: z.number().int().min(0).max(2_000_000_000).optional(),
});
export const DailyReportConfig = z.object({
  kind: z.literal('DAILY_REPORT'),
  localTime: LocalTime,
});
export const WeeklyReportConfig = z.object({
  kind: z.literal('WEEKLY_REPORT'),
  localTime: LocalTime,
  /** 0 = Sunday ... 6 = Saturday (the JavaScript convention), in the business's own time zone. */
  weekday: z.number().int().min(0).max(6),
});

export const RuleConfig = z.discriminatedUnion('kind', [
  LowStockConfig,
  NewOrderConfig,
  UnconfirmedConfig,
  DelayedConfig,
  CodDiscrepancyConfig,
  DailyReportConfig,
  WeeklyReportConfig,
]);
export type RuleConfig = z.infer<typeof RuleConfig>;

/** What the API stores and returns: the config without its `kind` (the rule already has one). */
export type RuleConfigBody<K extends AutomationKind = AutomationKind> = Omit<
  Extract<RuleConfig, { kind: K }>,
  'kind'
>;

export const DEFAULT_RULE_CONFIG: { [K in AutomationKind]: RuleConfigBody<K> } = {
  LOW_STOCK: { basis: 'reorder_point', includeZeroStock: true },
  NEW_ORDER: {},
  UNCONFIRMED_ORDER: { afterMinutes: 60 },
  DELAYED_ORDER: { afterHours: 48 },
  COD_DISCREPANCY: {},
  DAILY_REPORT: { localTime: '20:00' },
  WEEKLY_REPORT: { localTime: '09:00', weekday: 0 },
};

/** Check `config` for `kind`. Returns the cleaned config (unknown keys dropped) or the issues, with paths relative to the config. */
export function parseRuleConfig(
  kind: AutomationKind,
  config: unknown,
):
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; issues: { path: string; message: string }[] } {
  const input = typeof config === 'object' && config !== null ? config : {};
  const result = RuleConfig.safeParse({ ...input, kind });
  if (result.success) {
    const { kind: _kind, ...rest } = result.data;
    void _kind;
    return { ok: true, config: rest };
  }
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({
      path: i.path.filter((p) => p !== 'kind').join('.'),
      message: i.message,
    })),
  };
}

export const RuleChannels = z.object({
  inApp: z.boolean(),
  push: z.boolean(),
  email: z.boolean(),
  sms: z.boolean(),
  whatsapp: z.boolean(),
});
export type RuleChannels = z.infer<typeof RuleChannels>;
export const DEFAULT_RULE_CHANNELS: RuleChannels = {
  inApp: true,
  push: true,
  email: false,
  sms: false,
  whatsapp: false,
};

// ---- rules ------------------------------------------------------------------------------------------------------------

export const Run = z.object({
  id: Uuid,
  ruleId: Uuid,
  kind: AutomationKind,
  slotKey: z.string(),
  trigger: RunTrigger,
  scheduledFor: z.string(),
  status: RunStatus,
  attempts: z.number().int(),
  error: z.string().nullable(),
  createdCount: z.number().int(),
  skippedCount: z.number().int(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Run = z.infer<typeof Run>;

export const AutomationRule = z.object({
  kind: AutomationKind,
  /** False until someone saves the rule: the defaults are shown but nothing is evaluated. */
  configured: z.boolean(),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  channels: RuleChannels,
  /** What the rule needs from a person to receive it (`inventory:read`, `orders:read` or `finance:read`). */
  recipientPermission: z.enum(['inventory:read', 'orders:read', 'finance:read']),
  updatedAt: z.string().nullable(),
  lastRun: Run.nullable(),
});
export type AutomationRule = z.infer<typeof AutomationRule>;

export const AutomationRules = z.object({
  rules: z.array(AutomationRule),
  /** What this server can deliver: sms and whatsapp are only offered when a provider is configured. */
  providers: z.object({
    push: z.enum(['dev', 'expo']),
    sms: z.boolean(),
    whatsapp: z.boolean(),
    email: z.boolean(),
  }),
});
export type AutomationRules = z.infer<typeof AutomationRules>;

export const AutomationKindParam = z.object({ kind: AutomationKind });

export const UpdateRuleBody = z.object({
  enabled: z.boolean().optional(),
  /** Per-kind settings (see `RuleConfig`); replaces the whole config. */
  config: z.record(z.string(), z.unknown()).optional(),
  channels: RuleChannels.partial().optional(),
});
export type UpdateRuleBody = z.infer<typeof UpdateRuleBody>;

/** Send the same key again after a lost response and the first run is returned instead of starting another. */
export const RunRuleBody = z.object({ idempotencyKey: IdempotencyKey.optional() });
export type RunRuleBody = z.infer<typeof RunRuleBody>;

export const RunQuery = z.object({
  status: RunStatus.optional(),
  kind: AutomationKind.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RunQuery = z.infer<typeof RunQuery>;
export const RunPage = z.object({ items: z.array(Run), nextCursor: z.string().nullable() });
export type RunPage = z.infer<typeof RunPage>;

export const Delivery = z.object({
  id: Uuid,
  notificationId: Uuid,
  kind: AutomationKind,
  recipientUserId: Uuid,
  channel: NotificationChannel,
  status: DeliveryStatus,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Delivery = z.infer<typeof Delivery>;
export const DeliveryQuery = z.object({
  status: DeliveryStatus.optional(),
  channel: NotificationChannel.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type DeliveryQuery = z.infer<typeof DeliveryQuery>;
export const DeliveryPage = z.object({
  items: z.array(Delivery),
  nextCursor: z.string().nullable(),
});
export type DeliveryPage = z.infer<typeof DeliveryPage>;

// ---- notifications (per user) -----------------------------------------------------------------------------------------

/** Ids and counts only, enough to open the right screen; the app fetches the details after authenticating. */
export const NotificationData = z.object({
  kind: AutomationKind,
  count: z.number().int().optional(),
  orderIds: z.array(Uuid).optional(),
  variantIds: z.array(Uuid).optional(),
  discrepancyIds: z.array(Uuid).optional(),
  /** Report period, local dates (`2026-03-29`). */
  from: z.string().optional(),
  to: z.string().optional(),
});
export type NotificationData = z.infer<typeof NotificationData>;

export const Notification = z.object({
  id: Uuid,
  kind: AutomationKind,
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type Notification = z.infer<typeof Notification>;
export const NotificationQuery = z.object({
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type NotificationQuery = z.infer<typeof NotificationQuery>;
export const NotificationPage = z.object({
  items: z.array(Notification),
  nextCursor: z.string().nullable(),
});
export type NotificationPage = z.infer<typeof NotificationPage>;
export const UnreadCount = z.object({ count: z.number().int() });
export type UnreadCount = z.infer<typeof UnreadCount>;
export const ReadAllResult = z.object({ updated: z.number().int() });
export type ReadAllResult = z.infer<typeof ReadAllResult>;

export const NotificationPreference = z.object({
  kind: AutomationKind,
  inApp: z.boolean(),
  push: z.boolean(),
  email: z.boolean(),
  /** False when the person's role cannot receive this kind (the preference is kept but nothing is sent). */
  available: z.boolean(),
});
export type NotificationPreference = z.infer<typeof NotificationPreference>;
export const NotificationPreferences = z.object({ items: z.array(NotificationPreference) });
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;
export const UpdatePreferencesItem = z.object({
  kind: AutomationKind,
  inApp: z.boolean().optional(),
  push: z.boolean().optional(),
  email: z.boolean().optional(),
});
export const UpdateNotificationPreferencesBody = z.object({
  items: z.array(UpdatePreferencesItem).min(1).max(AUTOMATION_KINDS.length),
});
export type UpdateNotificationPreferencesBody = z.infer<typeof UpdateNotificationPreferencesBody>;
export const DEFAULT_PREFERENCE = { inApp: true, push: true, email: false } as const;

// ---- push devices -----------------------------------------------------------------------------------------------------

export const PushToken = z
  .string()
  .min(8)
  .max(512)
  .regex(/^[A-Za-z0-9._:=[\]-]+$/, 'A device token has only letters, digits and . _ : = [ ] -');
export const PushPlatform = z.enum(['ios', 'android']);
export const PushProviderName = z.enum(['dev', 'expo']);
export type PushProviderName = z.infer<typeof PushProviderName>;

export const RegisterPushDeviceBody = z.object({ token: PushToken, platform: PushPlatform });
export type RegisterPushDeviceBody = z.infer<typeof RegisterPushDeviceBody>;
export const PushDevice = z.object({
  id: Uuid,
  platform: PushPlatform,
  provider: PushProviderName,
  lastSeenAt: z.string(),
});
export type PushDevice = z.infer<typeof PushDevice>;
export const PushTokenParam = z.object({ token: PushToken });

// ---- messaging consent (sms, whatsapp) --------------------------------------------------------------------------------

export const MessagingConsent = z.object({
  channel: MessagingChannel,
  /** A provider is configured on this server for the channel. */
  configured: z.boolean(),
  granted: z.boolean(),
  phone: z.string().nullable(),
  grantedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type MessagingConsent = z.infer<typeof MessagingConsent>;
export const MessagingConsents = z.object({ items: z.array(MessagingConsent) });
export type MessagingConsents = z.infer<typeof MessagingConsents>;
export const UpdateMessagingConsentBody = z
  .object({
    channel: MessagingChannel,
    granted: z.boolean(),
    /** Required when granting: a Bangladeshi mobile number (any usual spelling). */
    phone: z.string().trim().min(5).max(40).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.granted && !b.phone)
      ctx.addIssue({ code: 'custom', path: ['phone'], message: 'A phone number is required' });
  });
export type UpdateMessagingConsentBody = z.infer<typeof UpdateMessagingConsentBody>;
