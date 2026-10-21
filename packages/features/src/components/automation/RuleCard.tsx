import type { AutomationRule, AutomationRules, RuleChannels, Run } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  Row,
  Section,
  Stack,
  Switch,
  Text,
  useT,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useAuth } from '../../core/auth';
import { useApi } from '../../core/runtime';
import { useIdempotencyKey } from '../../forms/useIdempotencyKey';
import { fieldErrorsFrom, messageFor } from '../../forms/errors';
import {
  fromDraft,
  invalidateAutomation,
  KIND_INFO,
  RULE_CHANNELS,
  RUN_STATUS_LABEL,
  toDraft,
  type RuleDraft,
} from '../../lib/automation';
import { formatWhen } from '../../lib/format';
import { RuleConfigFields } from './RuleConfigFields';

const WHO: Record<AutomationRule['recipientPermission'], string> = {
  'inventory:read': 'Goes to team members who can see stock.',
  'orders:read': 'Goes to team members who can see orders.',
  'finance:read': 'Goes to team members who can see finances.',
};

interface Draft {
  enabled: boolean;
  channels: RuleChannels;
  values: RuleDraft;
}
const draftOf = (rule: AutomationRule): Draft => ({
  enabled: rule.enabled,
  channels: rule.channels,
  values: toDraft(rule.kind, rule.config),
});

/** What a run did, in a sentence a person can check against the bell. */
function RunSummary({ run }: { run: Run }) {
  if (run.status === 'failed')
    return (
      <Alert tone="error" title="The run failed">
        {run.error ?? 'No details were recorded.'}
      </Alert>
    );
  if (run.status === 'skipped')
    return (
      <Alert tone="info">
        Nothing was sent: nobody is set to receive this alert. Check Notification preferences.
      </Alert>
    );
  return (
    <Alert tone="success" title="Run finished">
      {`New notifications: ${run.createdCount}. Skipped (already told or not needed): ${run.skippedCount}.`}
    </Alert>
  );
}

/**
 * One rule: switch it on, set its limits and channels, save, and run it now. Everything may be read; only someone who may manage
 * automation can change it.
 */
export function RuleCard({
  rule,
  providers,
  canManage,
}: {
  rule: AutomationRule;
  providers: AutomationRules['providers'];
  canManage: boolean;
}) {
  const api = useApi();
  const client = useQueryClient();
  const toast = useToast();
  const t = useT();
  const { session } = useAuth();
  const info = KIND_INFO[rule.kind];
  const [draft, setDraft] = useState(() => draftOf(rule));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Run | null>(null);
  const runKey = useIdempotencyKey();

  const saved = JSON.stringify(draftOf(rule));
  const dirty = JSON.stringify(draft) !== saved;
  // Take in what the server now holds (a save, another tab) only while there is nothing typed to lose.
  useEffect(() => {
    if (!dirty) setDraft(draftOf(rule));
  }, [saved]);

  const timezone = session?.tenant.timezone.replace(/_/g, ' ');
  const channels = RULE_CHANNELS.filter(
    (c) => (c.key !== 'sms' && c.key !== 'whatsapp') || providers[c.key] || draft.channels[c.key],
  );

  async function save() {
    setServerError('');
    const checked = fromDraft(rule.kind, draft.values);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api.automation.updateRule(rule.kind, {
        enabled: draft.enabled,
        config: checked.config,
        channels: draft.channels,
      });
      await invalidateAutomation(client);
      toast.success('Saved');
    } catch (error) {
      const fields = Object.fromEntries(
        Object.entries(fieldErrorsFrom(error)).map(([k, v]) => [k.replace(/^config\./, ''), v]),
      );
      setErrors(fields);
      setServerError(messageFor(error));
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    setResult(null);
    try {
      const run = await api.automation.runRule(rule.kind, runKey.key);
      runKey.renew();
      setResult(run);
      await invalidateAutomation(client);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setRunning(false);
    }
  }

  const status = !rule.configured ? (
    <Badge>Not set up yet</Badge>
  ) : (
    <Badge tone={rule.enabled ? 'success' : 'neutral'} dot>
      {rule.enabled ? 'On' : 'Off'}
    </Badge>
  );
  const last = rule.lastRun;

  return (
    <View role="group" aria-label={t(info.name)}>
      <Section title={info.name} description={info.description} actions={status}>
        <Switch
          label="Switched on"
          value={draft.enabled}
          disabled={!canManage}
          onChange={(enabled) => setDraft({ ...draft, enabled })}
        />
        <RuleConfigFields
          kind={rule.kind}
          draft={draft.values}
          errors={errors}
          editable={canManage}
          onChange={(key, value) =>
            setDraft({ ...draft, values: { ...draft.values, [key]: value } })
          }
        />
        {rule.kind === 'DAILY_REPORT' || rule.kind === 'WEEKLY_REPORT' ? (
          <Text variant="small" tone="muted">
            {`Times are in your business time zone: ${timezone ?? ''}.`}
          </Text>
        ) : null}
        <Stack gap={2}>
          <Text variant="label">Send through</Text>
          <Row gap={3} wrap>
            {channels.map((c) => (
              <Switch
                key={c.key}
                label={c.label}
                value={draft.channels[c.key]}
                disabled={!canManage}
                onChange={(on) =>
                  setDraft({ ...draft, channels: { ...draft.channels, [c.key]: on } })
                }
              />
            ))}
          </Row>
          <Text variant="small" tone="muted">
            {WHO[rule.recipientPermission]} Each person can also turn channels off for themselves.
          </Text>
        </Stack>
        {serverError ? <Alert tone="error">{serverError}</Alert> : null}
        {canManage ? (
          <Row gap={2} wrap>
            <Button icon="check" loading={saving} disabled={!dirty} onPress={() => void save()}>
              Save changes
            </Button>
            <Button
              variant="secondary"
              icon="refresh"
              loading={running}
              disabled={!rule.configured || !rule.enabled || dirty}
              onPress={() => void runNow()}
            >
              Run now
            </Button>
          </Row>
        ) : null}
        {canManage && (!rule.configured || !rule.enabled || dirty) ? (
          <Text variant="caption" tone="muted">
            Save and switch this rule on to run it now.
          </Text>
        ) : null}
        {result ? <RunSummary run={result} /> : null}
        {last ? (
          <Stack direction="row" gap={2} wrap>
            <Text variant="small" tone="muted">{`Last run: ${RUN_STATUS_LABEL[last.status]}`}</Text>
            <Text variant="small" tone="muted">
              {formatWhen(last.createdAt)}
            </Text>
            <Text
              variant="small"
              tone="muted"
            >{`New: ${last.createdCount}, skipped: ${last.skippedCount}`}</Text>
          </Stack>
        ) : (
          <Text variant="small" tone="muted">
            It has not run yet.
          </Text>
        )}
      </Section>
    </View>
  );
}
