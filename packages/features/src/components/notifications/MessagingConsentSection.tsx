import {
  UpdateMessagingConsentBody,
  type MessagingChannel,
  type MessagingConsent,
} from '@orderloop/contracts';
import { Badge, Button, Section, Stack, Text, TextField, useToast } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../core/runtime';
import { fieldErrorsFrom, messageFor, validate } from '../../forms/errors';
import { useMessagingConsents } from '../../lib/notifications';
import { QueryBoundary } from '../../shell/QueryBoundary';

const CHANNEL_NAME: Record<MessagingChannel, string> = { sms: 'SMS', whatsapp: 'WhatsApp' };

function ConsentRow({ consent }: { consent: MessagingConsent }) {
  const api = useApi();
  const client = useQueryClient();
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const name = CHANNEL_NAME[consent.channel];

  async function save(granted: boolean) {
    setError(undefined);
    const checked = validate(UpdateMessagingConsentBody, {
      channel: consent.channel,
      granted,
      ...(granted && phone.trim() ? { phone } : {}),
    });
    if (checked.errors) {
      setError('Enter your mobile number, for example 01712 345678.');
      return;
    }
    setBusy(true);
    try {
      const saved = await api.messagingConsents.update(checked.data);
      client.setQueryData(['messaging-consents'], saved.items);
      toast.success(granted ? `You will get ${name} alerts.` : `You will not get ${name} alerts.`);
    } catch (e) {
      setError(fieldErrorsFrom(e).phone ?? messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap={3}>
      <Stack direction="row" gap={2} align="center" wrap>
        <Text variant="label">{name}</Text>
        <Badge tone={consent.granted ? 'success' : 'neutral'} dot>
          {consent.granted ? 'You agreed' : 'Not agreed'}
        </Badge>
      </Stack>
      {consent.granted ? (
        <Stack gap={2} align="start">
          <Text tone="muted">
            {consent.phone ? `Alerts go to ${consent.phone}.` : 'Alerts go to the number you gave.'}
          </Text>
          <Button variant="secondary" loading={busy} onPress={() => void save(false)}>
            {`Stop ${name} alerts`}
          </Button>
          {error ? <Text tone="danger">{error}</Text> : null}
        </Stack>
      ) : (
        <Stack gap={3}>
          <TextField
            label={`Your ${name} number`}
            kind="text"
            keyboardType="phone-pad"
            value={phone}
            onChangeText={setPhone}
            error={error}
            hint="A Bangladeshi mobile number, for example 01712 345678."
          />
          <Stack align="start">
            <Button loading={busy} onPress={() => void save(true)}>
              {`Agree to get ${name} alerts`}
            </Button>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}

/**
 * Consent to alerts by SMS and WhatsApp, which are only ever sent to a person who has agreed here, to the number they gave.
 * Drawn only when the server can send at least one of them.
 */
export function MessagingConsentSection() {
  const query = useMessagingConsents();
  const offered = (query.data ?? []).filter((c) => c.configured);
  if (query.data && offered.length === 0) return null;
  return (
    <Section
      title="Text and WhatsApp alerts"
      description="Alerts are sent by SMS or WhatsApp only to people who agree here, and only to the number they give. You can stop at any time."
    >
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading your choices">
        <Stack gap={5}>
          {offered.map((c) => (
            <ConsentRow key={c.channel} consent={c} />
          ))}
        </Stack>
      </QueryBoundary>
    </Section>
  );
}
