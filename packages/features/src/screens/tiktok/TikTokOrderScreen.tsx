import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  KeyValueList,
  PageHeader,
  Row,
  Section,
  Stack,
  Text,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  MockBadge,
  ShopMoney,
  StockBadge,
  TikTokStatusBadge,
} from '../../components/tiktok/Badges';
import { TikTokFacts, TikTokMockNotice } from '../../components/tiktok/Notices';
import { OrderLines } from '../../components/tiktok/OrderLines';
import { AttentionMarker } from '../../components/tiktok/OrderListParts';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { messageFor } from '../../forms/errors';
import { formatWhen } from '../../lib/format';
import {
  explainStock,
  invalidateTikTok,
  totalsOf,
  typeText,
  useTikTokOrder,
} from '../../lib/tiktok';
import { QueryBoundary } from '../../shell/QueryBoundary';

/**
 * One TikTok order: its status and stock state with a sentence on why, the totals in the shop's currency, and each line with
 * the product it is linked to and what the stock did. It is a read-only mirror: nothing here changes TikTok, and there is no
 * buyer information.
 */
export function TikTokOrderScreen({ id }: { id: string }) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const client = useQueryClient();
  const allowed = can('orders:read');
  const query = useTikTokOrder(id, allowed);
  const order = query.data;
  const [syncing, setSyncing] = useState(false);
  const [failure, setFailure] = useState('');

  if (!allowed)
    return (
      <Stack gap={5}>
        <PageHeader title="TikTok order" />
        <EmptyState icon="shield" title="You do not have access to orders">
          Ask an owner or admin if you need to see TikTok orders.
        </EmptyState>
      </Stack>
    );

  async function syncShop() {
    if (!order) return;
    setSyncing(true);
    setFailure('');
    try {
      await api.tiktokShop.sync(order.connectionId);
      await invalidateTikTok(client);
      toast.success('Checked again');
    } catch (e) {
      setFailure(messageFor(e));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[{ label: 'TikTok orders', href: '/tiktok-orders' }, { label: 'Order' }]}
        title={order ? order.externalOrderId : 'TikTok order'}
        description="A read-only copy of an order on TikTok Shop. Nothing you do here changes anything on TikTok."
      />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading order">
        {order && (
          <Stack gap={5}>
            {(order.mock || order.mode === 'mock') && <TikTokMockNotice />}
            <Card variant="outlined" padding="md">
              <Stack gap={3}>
                <Row gap={2} wrap>
                  {order.mock && <MockBadge />}
                  <TikTokStatusBadge status={order.status} onHold={order.onHold} />
                  <StockBadge state={order.stockState} />
                  <Badge tone="info">{order.currency}</Badge>
                </Row>
                <Text>{explainStock(order)}</Text>
                <AttentionMarker order={order} />
                {(order.stockState === 'stock_short' || order.stockState === 'needs_mapping') &&
                  can('integrations:manage') && (
                    <Row gap={2} wrap>
                      <Button variant="secondary" loading={syncing} onPress={syncShop}>
                        Sync now
                      </Button>
                    </Row>
                  )}
                {!!failure && <Alert tone="error">{failure}</Alert>}
                <KeyValueList
                  layout="inline"
                  items={[
                    { label: 'Shop', value: order.shopName },
                    ...(order.region ? [{ label: 'Region', value: order.region }] : []),
                    ...(order.fulfilmentType
                      ? [{ label: 'Fulfilment', value: typeText(order.fulfilmentType) }]
                      : []),
                    ...(order.createdAtTiktok
                      ? [{ label: 'Placed on TikTok', value: formatWhen(order.createdAtTiktok) }]
                      : []),
                    ...(order.statusUpdatedAt
                      ? [{ label: 'Last updated', value: formatWhen(order.statusUpdatedAt) }]
                      : []),
                  ]}
                />
              </Stack>
            </Card>

            <Section
              title="Items"
              description="Each TikTok product is linked to one of yours by its SKU. No stock moves for an order until all of its items are linked."
            >
              <OrderLines order={order} />
            </Section>

            <Section
              title="Totals in the shop’s currency"
              description={`Amounts are in ${order.currency}, not taka, and are not part of your taka totals.`}
            >
              <KeyValueList
                layout="inline"
                items={[
                  ...totalsOf(order).map((t) => ({
                    label: t.label,
                    value: <ShopMoney minor={t.minor} order={order} />,
                  })),
                  {
                    label: 'Total',
                    emphasis: true,
                    value: <ShopMoney minor={order.totalMinor} order={order} variant="heading" />,
                  },
                ]}
              />
            </Section>
            <TikTokFacts />
          </Stack>
        )}
      </QueryBoundary>
    </Stack>
  );
}
