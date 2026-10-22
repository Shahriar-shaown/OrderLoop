import type { TikTokConnection, TikTokSyncResult } from '@orderloop/contracts';
import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  Row,
  Section,
  Stack,
  Text,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Platform } from 'react-native';
import { ChannelSwitcher } from '../../components/integrations/ChannelSwitcher';
import { TikTokMockTools } from '../../components/tiktok/MockTools';
import { TikTokFacts, TikTokMockNotice } from '../../components/tiktok/Notices';
import { ShopCard } from '../../components/tiktok/ShopCard';
import { ShopSelection } from '../../components/tiktok/ShopSelection';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { messageFor } from '../../forms/errors';
import { leaveApp } from '../../lib/leaveApp';
import {
  invalidateTikTok,
  oauthErrorMessage,
  TIKTOK_PATH,
  useTikTokOverview,
} from '../../lib/tiktok';
import { QueryBoundary } from '../../shell/QueryBoundary';

/** What a sync did, in a sentence. A mock shop has nothing to read from TikTok, only waiting orders to look at again. */
function syncText(result: TikTokSyncResult): string {
  if (result.mode === 'mock')
    return `Mock shop: waiting orders looked at again: ${result.reconciled}`;
  return `Read from TikTok: ${result.fetched}, changed: ${result.updated}, waiting orders looked at again: ${result.reconciled}`;
}

/**
 * Integrations, TikTok Shop: the shops whose orders OrderLoop mirrors (read-only) to keep stock honest. It is also where the
 * sign-in with TikTok returns to (`?session=` to choose shops, `?error=` when it did not work). In mock mode it carries a
 * notice that nothing is connected to TikTok and offers a simulated shop and orders to try it.
 * `browserSignIn` is false on the phone: signing in with TikTok needs a browser, so it points to the web app.
 */
export function TikTokIntegrationsScreen({
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
  const query = useTikTokOverview(allowed);
  const [working, setWorking] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<TikTokConnection | null>(null);
  const [failure, setFailure] = useState('');

  if (!allowed)
    return (
      <Stack gap={5}>
        <PageHeader title="Integrations" />
        <EmptyState icon="shield" title="You do not have access to integrations">
          Ask an owner or admin if you need to see which shops are connected.
        </EmptyState>
      </Stack>
    );

  const overview = query.data;
  const mock = overview?.mode === 'mock';
  const anyMockShop = overview?.connections.some((c) => c.mock) ?? false;

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

  async function sync(connection: TikTokConnection) {
    setWorking(connection.id);
    setFailure('');
    try {
      const result = await api.tiktokShop.sync(connection.id);
      await invalidateTikTok(client);
      toast.success(syncText(result));
      if (result.truncated) toast.info('More orders remain: sync again.');
    } catch (e) {
      setFailure(messageFor(e));
      await invalidateTikTok(client);
    } finally {
      setWorking(null);
    }
  }

  async function disconnect(connection: TikTokConnection) {
    setWorking(connection.id);
    setFailure('');
    try {
      await api.tiktokShop.disconnect(connection.id);
      await invalidateTikTok(client);
      toast.success(`Disconnected ${connection.shopName}`);
    } catch (e) {
      setFailure(messageFor(e));
    } finally {
      setLeaving(null);
      setWorking(null);
    }
  }

  const connectNote = !overview
    ? null
    : mock
      ? 'Signing in with TikTok is turned off in mock mode. Add a mock shop below to try the flow.'
      : !overview.liveConfigured
        ? 'Connecting to TikTok Shop is not set up on this server yet. Ask whoever runs the server to set it up.'
        : null;
  const mapping = overview?.needsMappingOrders ?? 0;
  const short = overview?.stockShortOrders ?? 0;
  const flagged = overview?.attentionOrders ?? 0;

  return (
    <Stack gap={5}>
      <PageHeader
        title="Integrations"
        description="Shops on TikTok Shop whose orders OrderLoop mirrors, so your stock stays honest."
      />
      <ChannelSwitcher current="tiktok" />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading integrations">
        {overview && (
          <Stack gap={5}>
            {(mock || anyMockShop) && <TikTokMockNotice />}
            <TikTokFacts />
            {error && (
              <Alert tone="error" title="Could not connect to TikTok Shop">
                {oauthErrorMessage(error)}
              </Alert>
            )}
            {!!failure && <Alert tone="error">{failure}</Alert>}
            {!canManage && (
              <Alert tone="info">
                Only an owner or admin can connect or change shops. You can see their status.
              </Alert>
            )}
            {session && canManage && !mock && (
              <ShopSelection sessionId={session} home={TIKTOK_PATH} />
            )}

            <Section
              title="Connected shops"
              actions={
                canManage && !mock && overview.liveConfigured && browserSignIn ? (
                  <Button
                    icon="plug"
                    loading={working === 'connect'}
                    onPress={() => signIn(() => api.tiktokShop.startOauth(), 'connect')}
                  >
                    Connect TikTok Shop
                  </Button>
                ) : undefined
              }
            >
              <Stack gap={3}>
                {canManage && connectNote && (
                  <>
                    <Button icon="plug" disabled>
                      Connect TikTok Shop
                    </Button>
                    <Text tone="muted">{connectNote}</Text>
                  </>
                )}
                {canManage && !mock && overview.liveConfigured && !browserSignIn && (
                  <Alert tone="info" title="Connect from the web app">
                    Signing in with TikTok needs a browser. Open OrderLoop on the web to connect or
                    reconnect a shop. You can see the status, sync and disconnect here.
                  </Alert>
                )}
                {overview.connections.length === 0 ? (
                  <EmptyState icon="plug" title="No shops connected yet">
                    {mock
                      ? 'Add a mock shop below to see how TikTok orders keep your stock up to date.'
                      : 'Connect a TikTok shop to mirror its orders and keep your stock honest.'}
                  </EmptyState>
                ) : (
                  overview.connections.map((c) => (
                    <ShopCard
                      key={c.id}
                      connection={c}
                      canManage={canManage}
                      canSignIn={browserSignIn && !mock}
                      busy={working === c.id}
                      onSync={sync}
                      onReconnect={(x) =>
                        signIn(
                          () =>
                            x.status === 'disconnected'
                              ? api.tiktokShop.startOauth()
                              : api.tiktokShop.reconnect(x.id),
                          x.id,
                        )
                      }
                      onDisconnect={setLeaving}
                    />
                  ))
                )}
              </Stack>
            </Section>

            <Section
              title="Orders and SKUs"
              description="TikTok orders are a separate list: they are not OrderLoop orders and are not in your finance figures."
            >
              <Stack gap={3}>
                {mapping + short + flagged > 0 && (
                  <Alert tone="warning" title="Orders that need you">
                    <Stack gap={1}>
                      {mapping > 0 && (
                        <Text>{`Orders waiting for a product to be mapped: ${mapping}`}</Text>
                      )}
                      {short > 0 && <Text>{`Orders waiting for stock: ${short}`}</Text>}
                      {flagged > 0 && (
                        <Text>{`Orders cancelled after shipping, to check: ${flagged}`}</Text>
                      )}
                      <Text>No stock moves for an order until all of its products are mapped.</Text>
                    </Stack>
                  </Alert>
                )}
                <Row gap={2} wrap>
                  {can('orders:read') && (
                    <Button variant="secondary" href="/tiktok-orders">
                      Open TikTok orders
                    </Button>
                  )}
                  {can('inventory:read') && (
                    <Button variant="secondary" href="/tiktok-orders/sku-mapping">
                      {overview.unmappedSkus > 0
                        ? `Map SKUs (${overview.unmappedSkus} waiting)`
                        : 'SKU mapping'}
                    </Button>
                  )}
                </Row>
              </Stack>
            </Section>

            {mock && canManage && <TikTokMockTools connections={overview.connections} />}
          </Stack>
        )}
      </QueryBoundary>
      <ConfirmDialog
        open={leaving !== null}
        title={`Disconnect ${leaving?.shopName ?? ''}?`}
        confirmLabel="Disconnect"
        danger
        busy={leaving !== null && working === leaving.id}
        onConfirm={() => leaving && disconnect(leaving)}
        onClose={() => setLeaving(null)}
      >
        <Text>
          OrderLoop stops reading orders from this shop and deletes the saved access. Orders and
          stock already recorded stay as they are. Nothing changes on TikTok. You can connect the
          shop again later.
        </Text>
      </ConfirmDialog>
    </Stack>
  );
}
