import {
  AUTOMATION_KINDS,
  DEFAULT_RULE_CONFIG,
  parseRuleConfig,
  type AutomationKind,
  type NotificationChannel,
  type RuleChannels,
  type RunStatus,
} from '@orderloop/contracts';
import type { IconName, SelectOption, Tone } from '@orderloop/ui';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../core/runtime';
import { invalidateKeys } from './invalidate';

export { AUTOMATION_KINDS };

/** What a kind is called and does, in words a shop owner uses. */
export const KIND_INFO: Record<
  AutomationKind,
  { name: string; description: string; icon: IconName }
> = {
  LOW_STOCK: {
    name: 'Low stock',
    description:
      'Tells you when a product is running low or has run out, so you can reorder in time.',
    icon: 'layers',
  },
  NEW_ORDER: {
    name: 'New orders',
    description: 'Tells you as soon as an order comes in.',
    icon: 'box',
  },
  UNCONFIRMED_ORDER: {
    name: 'Orders waiting for confirmation',
    description: 'Reminds you about orders that nobody has confirmed yet.',
    icon: 'clock',
  },
  DELAYED_ORDER: {
    name: 'Orders running late',
    description: 'Flags orders that are taking too long to be handed to a courier or delivered.',
    icon: 'truck',
  },
  COD_DISCREPANCY: {
    name: 'Cash on delivery differences',
    description: 'Tells you when a courier statement does not match the cash you expected.',
    icon: 'wallet',
  },
  DAILY_REPORT: {
    name: 'Daily report',
    description: 'A short summary of today at the time you choose.',
    icon: 'bar-chart',
  },
  WEEKLY_REPORT: {
    name: 'Weekly report',
    description: 'A summary of the last 7 days on the day and at the time you choose.',
    icon: 'calendar',
  },
};

/** The channels a rule can use, in the order they are shown. */
export const RULE_CHANNELS: { key: keyof RuleChannels; label: string }[] = [
  { key: 'inApp', label: 'In the app' },
  { key: 'push', label: 'Push to phones' },
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS' },
  { key: 'whatsapp', label: 'WhatsApp' },
];

export const DELIVERY_CHANNEL_LABEL: Record<NotificationChannel, string> = {
  in_app: 'In the app',
  push: 'Push',
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
};

export const RUN_STATUS_TONE: Record<RunStatus, Tone> = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'success',
  failed: 'error',
  skipped: 'neutral',
};
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Waiting to run',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  skipped: 'Nobody to tell',
};

export const WEEKDAY_OPTIONS: SelectOption[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
].map((label, i) => ({ value: String(i), label }));

// ---- the settings of one rule, as a form --------------------------------------------------------------------------------

/** What a person has typed for a rule: text for numbers, times and choices, true/false for switches. */
export type RuleDraft = Record<string, string | boolean>;

interface Common {
  key: string;
  label: string;
  hint?: string;
  /** Shown only while this is true (a fixed quantity matters only for the fixed basis). */
  when?: (draft: RuleDraft) => boolean;
}
export type ConfigField =
  | (Common & { type: 'number'; min: number; max: number; optional?: boolean })
  /** An amount in taka that the API keeps in paisa. */
  | (Common & { type: 'money'; maxTaka: number; optional?: boolean })
  | (Common & { type: 'time' })
  | (Common & { type: 'choice'; options: SelectOption[] })
  | (Common & { type: 'toggle' });

const REPORT_TIME: ConfigField = {
  type: 'time',
  key: 'localTime',
  label: 'Send at',
  hint: 'In 24-hour time, for example 20:00.',
};

/** The limits are the contract's (checked against it in the tests); the API enforces them for real. */
export const CONFIG_FIELDS: Record<AutomationKind, ConfigField[]> = {
  LOW_STOCK: [
    {
      type: 'choice',
      key: 'basis',
      label: 'Alert when stock is at or below',
      options: [
        { value: 'reorder_point', label: 'Each product’s own reorder point' },
        { value: 'fixed', label: 'The same number for every product' },
      ],
      hint: 'A reorder point of 0 means that product never alerts.',
    },
    {
      type: 'number',
      key: 'fixedQuantity',
      label: 'Number of units',
      min: 0,
      max: 1_000_000,
      when: (d) => d.basis === 'fixed',
    },
    {
      type: 'toggle',
      key: 'includeZeroStock',
      label: 'Also alert for products that are completely out of stock',
    },
  ],
  NEW_ORDER: [],
  UNCONFIRMED_ORDER: [
    {
      type: 'number',
      key: 'afterMinutes',
      label: 'First reminder after (minutes)',
      min: 5,
      max: 10080,
    },
    {
      type: 'number',
      key: 'repeatEveryMinutes',
      label: 'Remind again every (minutes, optional)',
      min: 5,
      max: 10080,
      optional: true,
      hint: 'Leave empty for one reminder. An order is reminded about at most 3 times.',
    },
  ],
  DELAYED_ORDER: [
    {
      type: 'number',
      key: 'afterHours',
      label: 'Running late after (hours)',
      min: 1,
      max: 720,
      hint: 'Counted from when the order was confirmed or shipped.',
    },
  ],
  COD_DISCREPANCY: [
    {
      type: 'money',
      key: 'minAmountMinor',
      label: 'Ignore differences smaller than (৳, optional)',
      maxTaka: 20_000_000,
      optional: true,
      hint: 'Leave empty to be told about every difference.',
    },
  ],
  DAILY_REPORT: [REPORT_TIME],
  WEEKLY_REPORT: [
    { type: 'choice', key: 'weekday', label: 'Send on', options: WEEKDAY_OPTIONS },
    REPORT_TIME,
  ],
};

const visibleFields = (kind: AutomationKind, draft: RuleDraft) =>
  CONFIG_FIELDS[kind].filter((f) => !f.when || f.when(draft));

/** The form's starting values from a rule's saved (or default) settings. */
export function toDraft(kind: AutomationKind, config: Record<string, unknown>): RuleDraft {
  const defaults = DEFAULT_RULE_CONFIG[kind] as Record<string, unknown>;
  const draft: RuleDraft = {};
  for (const f of CONFIG_FIELDS[kind]) {
    const value = config[f.key] ?? defaults[f.key];
    if (f.type === 'toggle') draft[f.key] = value === true;
    else if (f.type === 'money')
      draft[f.key] = typeof value === 'number' ? String(value / 100) : '';
    else draft[f.key] = value === undefined ? '' : String(value);
  }
  return draft;
}

export type DraftResult =
  { ok: true; config: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/** The API's settings from what was typed, or the message for each field that is wrong (in the words of the limits). */
export function fromDraft(kind: AutomationKind, draft: RuleDraft): DraftResult {
  const config: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of visibleFields(kind, draft)) {
    const raw = draft[f.key];
    const text = typeof raw === 'string' ? raw.trim() : '';
    switch (f.type) {
      case 'toggle':
        config[f.key] = raw === true;
        break;
      case 'choice':
        config[f.key] = f.key === 'weekday' ? Number(text) : text;
        break;
      case 'time':
        if (/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) config[f.key] = text;
        else errors[f.key] = 'Use 24-hour time such as 20:00.';
        break;
      case 'number':
        if (!text && f.optional) break;
        if (/^\d+$/.test(text) && Number(text) >= f.min && Number(text) <= f.max)
          config[f.key] = Number(text);
        else errors[f.key] = `Enter a whole number from ${f.min} to ${f.max}.`;
        break;
      case 'money': {
        if (!text && f.optional) break;
        const taka = /^\d+(\.\d{1,2})?$/.test(text) ? Number(text) : NaN;
        if (taka >= 0 && taka <= f.maxTaka) config[f.key] = Math.round(taka * 100);
        else errors[f.key] = `Enter an amount from 0 to ${f.maxTaka}.`;
        break;
      }
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  // The contract has the last word, so a rule this form lets through is one the API accepts.
  const checked = parseRuleConfig(kind, config);
  if (checked.ok) return { ok: true, config: checked.config };
  return {
    ok: false,
    errors: Object.fromEntries(checked.issues.map((i) => [i.path || 'form', i.message])),
  };
}

// ---- reading ------------------------------------------------------------------------------------------------------------

export function useAutomationRules(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['automation', 'rules'],
    enabled,
    queryFn: () => api.automation.rules(),
  });
}

/** The newest runs and deliveries that went wrong. */
export function useFailedRuns() {
  const api = useApi();
  return useQuery({
    queryKey: ['automation', 'runs', 'failed'],
    queryFn: () => api.automation.runs({ status: 'failed', limit: 25 }),
  });
}
export function useFailedDeliveries() {
  const api = useApi();
  return useQuery({
    queryKey: ['automation', 'deliveries', 'failed'],
    queryFn: () => api.automation.deliveries({ status: 'failed', limit: 25 }),
  });
}

/** After a rule changes or runs: the rules (last run), the problems, and the bell. */
export const invalidateAutomation = (client: Parameters<typeof invalidateKeys>[0]) =>
  invalidateKeys(client, ['automation', 'notifications']);
