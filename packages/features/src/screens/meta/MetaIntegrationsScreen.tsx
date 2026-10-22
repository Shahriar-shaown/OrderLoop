import type { SocialConnection } from '@orderloop/contracts';
import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  Section,
  Stack,
  Text,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Platform } from 'react-native';
import { ChannelSwitcher } from '../../components/integrations/ChannelSwitcher';
import { ConnectionCard } from '../../components/meta/ConnectionCard';
import { MockNotice } from '../../components/meta/MockNotice';
import { MockTools } from '../../components/meta/MockTools';
import { PageSelection } from '../../components/meta/PageSelection';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { messageFor } from '../../forms/errors';
import { leaveApp } from '../../lib/leaveApp';
import { invalidateMeta, oauthErrorMessage, useMetaOverview } from '../../lib/meta';
import { META_PATH } from '../../lib/tiktok';
import { QueryBoundary } from '../../shell/QueryBoundary';

export const INTEGRATIONS_PATH = META_PATH;

/**
 * Integrations: the Facebook Pages and Instagram accounts whose customer messages become draft orders. It is also where
 * the sign-in with Meta returns to (`?session=` to choose Pages, `?error=` when it did not work). In mock mode it carries a
 * notice that nothing is connected to Meta and offers a simulated account and message to try it.
 * `browserSignIn` is false on the phone: signing in with Meta needs a browser, so it points to the web app.
 */
export function MetaIntegrationsScreen({
  session,
  error,
  browserSignIn = Platform.OS === 'web',
}: {
  session?: string | undefined;
  error?: string | undefined;
  browserSignIn?: boolean;
}) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const client = useQueryClient();
  const allowed = can('integrations:read');
  const canManage = can('integrations:manage');
  const query = useMetaOverview(allowed);
  const [working, setWorking] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<SocialConnection | null>(null);
  const [failure, setFailure] = useState('');

  if (!allowed)
    return (
      <Stack gap={5}>
        <PageHeader title="Integrations" />
        <EmptyState icon="shield" title="You do not have access to integrations">
          Ask an owner or admin if you need to see which accounts are connected.
        </EmptyState>
      </Stack>
    );

  const overview = query.data;
  const mock = overview?.mode === 'mock';
  const anyMockAccount = overview?.connections.some((c) => c.mock) ?? false;

  async function signIn(start: () => Promise<{ authorizeUrl: string }>, key: string) {
    setWorking(key);
    setFailure('');
    try {
      leaveApp((await start()).authorizeUrl);
    } catch (e) {
      setFailure(messageFor(e));
      setWorking(null);
    }
  }

  async function disconnect(connection: SocialConnection) {
    setWorking(connection.id);
    setFailure('');
    try {
      await api.meta.disconnect(connection.id);
      await invalidateMeta(client);
      toast.success(`Disconnected ${connection.displayName}`);
      setLeaving(null);
    } catch (e) {
      setFailure(messageFor(e));
      setLeaving(null);
    } finally {
      setWorking(null);
    }
  }

  const connectNote = !overview
    ? null
    : mock
      ? 'Signing in with Meta is turned off in mock mode. Add a mock account below to try the flow.'
      : !overview.liveConfigured
        ? 'Connecting to Meta is not set up on this server yet. Ask whoever runs the server to set it up.'
        : null;

  return (
    <Stack gap={5}>
      <PageHeader
        title="Integrations"
        description="Facebook Pages and Instagram accounts whose customer messages become draft orders for you to review. OrderLoop only receives messages: it never replies."
      />
      <ChannelSwitcher current="meta" />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading integrations">
        {overview && (
          <Stack gap={5}>
            {(mock || anyMockAccount) && <MockNotice />}
            {error && (
              <Alert tone="error" title="Could not connect to Meta">
                {oauthErrorMessage(error)}
              </Alert>
            )}
            {!!failure && <Alert tone="error">{failure}</Alert>}
            {!canManage && (
              <Alert tone="info">
                Only an owner or admin can connect or change accounts. You can see their status.
              </Alert>
            )}
            {session && canManage && !mock && (
              <PageSelection sessionId={session} home={INTEGRATIONS_PATH} />
            )}

            <Section
              title="Connected accounts"
              actions={
                canManage && !mock && overview.liveConfigured && browserSignIn ? (
                  <Button
                    icon="plug"
                    loading={working === 'connect'}
                    onPress={() => signIn(() => api.meta.startOauth(), 'connect')}
                  >
                    Connect Facebook & Instagram
                  </Button>
                ) : undefined
              }
            >
              <Stack gap={3}>
                {canManage && connectNote && (
                  <>
                    <Button icon="plug" disabled>
                      Connect Facebook & Instagram
                    </Button>
                    <Text tone="muted">{connectNote}</Text>
                  </>
                )}
                {canManage && !mock && overview.liveConfigured && !browserSignIn && (
                  <Alert tone="info" title="Connect from the web app">
                    Signing in with Meta needs a browser. Open OrderLoop on the web to connect or
                    reconnect an account. You can see the status and disconnect here.
                  </Alert>
                )}
                {overview.connections.length === 0 ? (
                  <EmptyState icon="plug" title="No accounts connected yet">
                    {mock
                      ? 'Add a mock account below to see how customer messages become draft orders.'
                      : 'Connect a Facebook Page, and its Instagram account, to receive customer messages as draft orders.'}
                  </EmptyState>
                ) : (
                  overview.connections.map((c) => (
                    <ConnectionCard
                      key={c.id}
                      connection={c}
                      canManage={canManage}
                      canSignIn={browserSignIn && !mock}
                      busy={working === c.id}
                      onReconnect={(x) =>
                        signIn(
                          () =>
                            x.status === 'disconnected'
                              ? api.meta.startOauth()
                              : api.meta.reconnect(x.id),
                          x.id,
                        )
                      }
                      onDisconnect={setLeaving}
                    />
                  ))
                )}
              </Stack>
            </Section>

            {mock && canManage && <MockTools connections={overview.connections} canAdd />}
          </Stack>
        )}
      </QueryBoundary>
      <ConfirmDialog
        open={leaving !== null}
        title={`Disconnect ${leaving?.displayName ?? ''}?`}
        confirmLabel="Disconnect"
        danger
        busy={leaving !== null && working === leaving.id}
        onConfirm={() => leaving && disconnect(leaving)}
        onClose={() => setLeaving(null)}
      >
        <Text>
          OrderLoop stops receiving messages from this account and deletes the saved access. Drafts
          already made stay until they expire. You can connect it again later.
        </Text>
      </ConfirmDialog>
    </Stack>
  );
}
