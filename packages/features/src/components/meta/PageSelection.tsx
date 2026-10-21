import type { ConnectPagesResult } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Row,
  Section,
  Stack,
  Text,
  useNavigation,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../core/runtime';
import { metaErrorText } from '../../forms/errors';
import { useFormState } from '../../forms/forms';
import { invalidateMeta, useMetaSession } from '../../lib/meta';
import { QueryBoundary } from '../../shell/QueryBoundary';

/**
 * The step after signing in with Meta: choose which Pages to connect. A Page's Instagram account comes with it. A Page
 * that is already connected cannot be chosen; a Page that could not be connected says why, and the others still are.
 */
export function PageSelection({ sessionId, home }: { sessionId: string; home: string }) {
  const api = useApi();
  const toast = useToast();
  const navigation = useNavigation();
  const client = useQueryClient();
  const query = useMetaSession(sessionId, true);
  const form = useFormState({});
  const [chosen, setChosen] = useState<string[]>([]);
  const [result, setResult] = useState<ConnectPagesResult | null>(null);
  const session = query.data;
  const nameOf = (id: string) => session?.pages.find((p) => p.id === id)?.name ?? id;

  async function connect() {
    if (!session || chosen.length === 0) return;
    let outcome: ConnectPagesResult | null = null;
    const ok = await form.run(async () => {
      outcome = await api.meta.connect({ sessionId, pageIds: chosen });
      await invalidateMeta(client);
    });
    const done = outcome as ConnectPagesResult | null;
    if (!ok || !done) return;
    if (done.failures.length === 0) {
      toast.success(
        `Connected ${done.connections.length} account${done.connections.length === 1 ? '' : 's'}`,
      );
      navigation.replace(home);
    } else {
      setResult(done);
      setChosen([]);
    }
  }

  return (
    <Section
      title="Choose the Pages to connect"
      description={
        session?.reconnectConnectionId
          ? 'Choose the Page you are reconnecting. Its Instagram account is reconnected with it.'
          : 'A Page’s linked Instagram account is connected with it. OrderLoop only receives messages: it never replies.'
      }
    >
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading your Pages">
        {session && (
          <Stack gap={3}>
            {!!form.formError && <Alert tone="error">{form.formError}</Alert>}
            {result && (
              <Alert tone="warning" title="Some Pages could not be connected">
                <Stack gap={2}>
                  {result.failures.map((f) => (
                    <Stack key={f.pageId} gap={1}>
                      <Text weight="medium">{nameOf(f.pageId)}</Text>
                      <Text>{metaErrorText(f.code, f.message)}</Text>
                    </Stack>
                  ))}
                  {result.connections.length > 0 && (
                    <Text>{`${result.connections.length} other account${result.connections.length === 1 ? ' was' : 's were'} connected.`}</Text>
                  )}
                </Stack>
              </Alert>
            )}
            {session.pages.length === 0 && (
              <Text tone="muted">
                Meta did not list any Page you can manage. Make sure you have full control of the
                Page and try again.
              </Text>
            )}
            {session.pages.map((page) => {
              const blocked = page.alreadyConnected;
              return (
                <Card key={page.id} variant="outlined" padding="sm">
                  <Row gap={3} wrap justify="between">
                    <Checkbox
                      label={page.name}
                      disabled={blocked}
                      checked={chosen.includes(page.id)}
                      onChange={(on) =>
                        setChosen((all) =>
                          on ? [...all, page.id] : all.filter((x) => x !== page.id),
                        )
                      }
                    />
                    <Row gap={2} wrap>
                      <Badge tone="info">Facebook</Badge>
                      {page.instagram && (
                        <Badge tone="info">
                          {page.instagram.username
                            ? `Instagram @${page.instagram.username}`
                            : 'Instagram'}
                        </Badge>
                      )}
                      {blocked && <Badge>Already connected</Badge>}
                    </Row>
                  </Row>
                </Card>
              );
            })}
            <Row gap={2} wrap>
              <Button loading={form.busy} disabled={chosen.length === 0} onPress={connect}>
                Connect selected
              </Button>
              <Button variant="tertiary" onPress={() => navigation.replace(home)}>
                {result ? 'Done' : 'Cancel'}
              </Button>
            </Row>
          </Stack>
        )}
      </QueryBoundary>
      {query.isError && (
        <Button variant="tertiary" onPress={() => navigation.replace(home)}>
          Back to integrations
        </Button>
      )}
    </Section>
  );
}
