import type { MockEventResult, SocialConnection, SocialProvider } from '@orderloop/contracts';
import {
  Alert,
  Button,
  Link,
  Row,
  Section,
  SelectField,
  Stack,
  Text,
  TextField,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../core/runtime';
import { useFormState } from '../../forms/forms';
import {
  invalidateMeta,
  MOCK_MESSAGE,
  MOCK_SENDER,
  mockMessageId,
  PROVIDER_LABEL,
} from '../../lib/meta';

/** What happened to a test message, in words. */
function outcomeText(result: MockEventResult): string {
  if (result.duplicate) return 'This exact message was already received. Nothing new was created.';
  if (result.status === 'ignored')
    return 'The message did not look like an order (no phone number, product or order word), so no draft was made.';
  if (result.status === 'failed') return 'The message could not be processed.';
  return result.draftId
    ? 'The message was received and a draft order is waiting for review.'
    : 'The message was received.';
}

/**
 * Mock mode only: add a simulated account and send a simulated customer message through the same pipeline a real one uses.
 * Only for trying OrderLoop without a Meta account: it says so, and nothing reaches Meta.
 */
export function MockTools({
  connections,
  canAdd,
}: {
  connections: SocialConnection[];
  canAdd: boolean;
}) {
  const api = useApi();
  const toast = useToast();
  const client = useQueryClient();
  const usable = connections.filter((c) => c.mock && c.status === 'active');
  const [provider, setProvider] = useState<SocialProvider>('facebook_page');
  const [connectionId, setConnectionId] = useState('');
  const [result, setResult] = useState<MockEventResult | null>(null);
  const add = useFormState({});
  const send = useFormState({ senderId: MOCK_SENDER, text: MOCK_MESSAGE });
  const target = usable.find((c) => c.id === connectionId) ?? usable[0];

  async function addAccount() {
    const ok = await add.run(async () => {
      await api.meta.mockConnection({ provider });
      await invalidateMeta(client);
    });
    if (ok) toast.success('Mock account added');
  }

  async function sendMessage() {
    if (!target) return;
    const text = send.values.text.trim();
    const senderId = send.values.senderId.trim();
    if (!text) return send.setErrors({ text: 'Write a message to send' });
    if (!senderId) return send.setErrors({ senderId: 'Enter a sender id' });
    setResult(null);
    const ok = await send.run(async () => {
      // The same text from the same sender is the same message: it is never counted twice.
      const sent = await api.meta.mockEvent({
        connectionId: target.id,
        senderId,
        text,
        messageId: mockMessageId(target.id, senderId, text),
      });
      setResult(sent);
      await invalidateMeta(client);
    });
    if (!ok) setResult(null);
  }

  return (
    <Section
      title="Try it without Meta"
      description="Add a simulated account, then send a simulated customer message to see how a draft order appears."
    >
      <Stack gap={5}>
        {canAdd && (
          <Stack gap={3}>
            {!!add.formError && <Alert tone="error">{add.formError}</Alert>}
            <Row gap={3} wrap align="end">
              <SelectField
                label="Account type"
                value={provider}
                onChange={(v) => setProvider(v as SocialProvider)}
                options={(Object.keys(PROVIDER_LABEL) as SocialProvider[]).map((p) => ({
                  value: p,
                  label: p === 'instagram' ? 'Instagram (mock)' : 'Facebook Page (mock)',
                }))}
              />
              <Button variant="secondary" icon="plus" loading={add.busy} onPress={addAccount}>
                Add mock account
              </Button>
            </Row>
          </Stack>
        )}
        <Stack gap={3}>
          <Text variant="heading">Send a test message</Text>
          {usable.length === 0 ? (
            <Text tone="muted">Add a mock account first, then you can send it a message.</Text>
          ) : (
            <>
              {!!send.formError && <Alert tone="error">{send.formError}</Alert>}
              {usable.length > 1 && (
                <SelectField
                  label="Send to"
                  value={target?.id ?? ''}
                  onChange={setConnectionId}
                  options={usable.map((c) => ({ value: c.id, label: c.displayName }))}
                />
              )}
              <TextField
                label="Customer message"
                multiline
                {...send.field('text')}
                hint="This is a made-up customer message. Change it to try other orders."
              />
              <TextField
                label="Sender id"
                {...send.field('senderId')}
                hint="The same sender id continues the same conversation."
              />
              <Row gap={3} wrap>
                <Button loading={send.busy} onPress={sendMessage}>
                  Send test message
                </Button>
              </Row>
              <Text variant="caption" tone="muted">
                Sending the same text again from the same sender will not create another draft.
              </Text>
              {result && (
                <Alert tone={result.status === 'failed' ? 'error' : 'success'}>
                  <Stack gap={1}>
                    <Text>{outcomeText(result)}</Text>
                    {result.draftId && (
                      <Link href={`/social-orders/${result.draftId}`} variant="inline">
                        Open the draft
                      </Link>
                    )}
                  </Stack>
                </Alert>
              )}
            </>
          )}
        </Stack>
      </Stack>
    </Section>
  );
}
