import type { NotificationPreference } from '@orderloop/contracts';
import { PageHeader, Section, Stack, Switch, Text, useT, useToast } from '@orderloop/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { MessagingConsentSection } from '../../components/notifications/MessagingConsentSection';
import { PushAlerts } from '../../components/notifications/PushAlerts';
import { messageFor } from '../../forms/errors';
import { KIND_INFO } from '../../lib/automation';
import { useNotificationPreferences, useSavePreference } from '../../lib/notifications';
import { QueryBoundary } from '../../shell/QueryBoundary';

const CHANNELS = [
  { field: 'inApp', label: 'In the app' },
  { field: 'push', label: 'Push to my phone' },
  { field: 'email', label: 'Email' },
] as const;

function KindPreferences({ preference }: { preference: NotificationPreference }) {
  const t = useT();
  const toast = useToast();
  const save = useSavePreference();
  const [saving, setSaving] = useState<string | null>(null);
  const info = KIND_INFO[preference.kind];

  async function change(field: (typeof CHANNELS)[number]['field'], value: boolean) {
    setSaving(field);
    try {
      await save.mutateAsync({ kind: preference.kind, [field]: value });
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setSaving(null);
    }
  }

  return (
    <View role="group" aria-label={t(info.name)}>
      <Stack gap={2}>
        <Text variant="label">{info.name}</Text>
        <Text tone="muted">{info.description}</Text>
        {preference.available ? null : (
          <Text variant="small" tone="warning">
            Your role does not receive this alert, so these choices have no effect.
          </Text>
        )}
        <Stack direction="row" gap={3} wrap>
          {CHANNELS.map((c) => (
            <Switch
              key={c.field}
              label={c.label}
              value={preference[c.field]}
              disabled={!preference.available || saving === c.field}
              onChange={(value) => void change(c.field, value)}
            />
          ))}
        </Stack>
      </Stack>
    </View>
  );
}

/** What each person wants to be told about, and where: in the app, as a push to their phone, or by email. */
export function NotificationPreferencesScreen() {
  const query = useNotificationPreferences();
  return (
    <Stack gap={5}>
      <PageHeader
        title="Notification preferences"
        description="Choose how you hear about each kind of alert. These choices are yours alone and apply to this business."
      />
      <PushAlerts variant="status" />
      <Section
        title="Your alerts"
        description="Switching a channel off here stops it for you, even when the business has it on."
      >
        <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading your preferences">
          <Stack gap={5}>
            {query.data?.map((p) => (
              <KindPreferences key={p.kind} preference={p} />
            ))}
          </Stack>
        </QueryBoundary>
      </Section>
      <MessagingConsentSection />
    </Stack>
  );
}
