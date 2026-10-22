import {
  DataTable,
  EmptyState,
  FilterMenu,
  Link,
  LoadMore,
  PageHeader,
  Row,
  Stack,
  Tabs,
  Text,
  useNavigation,
  type TabItem,
} from '@orderloop/ui';
import { useState } from 'react';
import { TikTokMockNotice } from '../../components/tiktok/Notices';
import { OrderCard, orderColumns } from '../../components/tiktok/OrderListParts';
import { SkuMappingPanel } from '../../components/tiktok/SkuMappingPanel';
import { useCan } from '../../core/permissions';
import {
  ORDER_STATUS,
  STOCK_FILTERS,
  TIKTOK_PATH,
  useTikTokOrders,
  useTikTokOverview,
} from '../../lib/tiktok';
import { QueryBoundary } from '../../shell/QueryBoundary';

export type TikTokOrdersView = 'orders' | 'sku-mapping';

const STATUS_OPTIONS = Object.entries(ORDER_STATUS).map(([value, s]) => ({
  value,
  label: s.label,
}));

/**
 * TikTok orders: a separate, read-only list of the orders mirrored from TikTok Shop, with what the stock did for each. They
 * are in the shop's own currency, are not OrderLoop orders and are not in finance. The second tab is the SKU mapping: the
 * TikTok products waiting to be linked to one of yours, which blocks the orders that contain them.
 */
export function TikTokOrdersScreen({ view = 'orders' }: { view?: TikTokOrdersView }) {
  const can = useCan();
  const navigation = useNavigation();
  const [tab, setTab] = useState<TikTokOrdersView>(view);
  const [stock, setStock] = useState('');
  const [status, setStatus] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const canOrders = can('orders:read');
  const canSkus = can('inventory:read');
  const overview = useTikTokOverview(can('integrations:read'));
  const query = useTikTokOrders({ stock, status, connectionId }, canOrders && tab === 'orders');

  if (!canOrders)
    return (
      <Stack gap={5}>
        <PageHeader title="TikTok orders" />
        <EmptyState icon="shield" title="You do not have access to orders">
          Ask an owner or admin if you need to see TikTok orders.
        </EmptyState>
      </Stack>
    );

  const pages = query.data?.pages ?? [];
  const counts = pages[0]?.counts ?? {};
  const rows = pages.flatMap((p) => p.items);
  const mock =
    overview.data?.mode === 'mock' || pages[0]?.mode === 'mock' || rows.some((o) => o.mock);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const attention = overview.data?.attentionOrders;
  const connections = overview.data?.connections.filter((c) => c.status !== 'disconnected') ?? [];

  const stockTabs: TabItem[] = [
    ...STOCK_FILTERS.map((f) => ({
      value: f.value || 'all',
      label: f.label,
      count: f.value ? (counts[f.value] ?? 0) : total,
    })),
    { value: 'attention', label: 'Needs a look', count: attention },
  ];
  const sectionTabs: TabItem[] = [
    { value: 'orders', label: 'Orders' },
    ...(canSkus
      ? [{ value: 'sku-mapping', label: 'SKU mapping', count: overview.data?.unmappedSkus }]
      : []),
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="TikTok orders"
        description="Orders from your TikTok Shop, copied here so OrderLoop can keep your stock honest. They are in the shop’s own currency, are not OrderLoop orders and are not part of your taka totals. OrderLoop only reads TikTok: it never changes anything there."
      />
      {mock && <TikTokMockNotice />}
      {sectionTabs.length > 1 && (
        <Tabs
          label="TikTok orders sections"
          items={sectionTabs}
          value={tab}
          onChange={(v) => setTab(v as TikTokOrdersView)}
        />
      )}
      {tab === 'sku-mapping' && canSkus ? (
        <SkuMappingPanel mock={mock} />
      ) : (
        <Stack gap={4}>
          <Tabs
            variant="chips"
            label="Stock state"
            items={stockTabs}
            value={stock || 'all'}
            onChange={(v) => setStock(v === 'all' ? '' : v)}
          />
          <Row gap={3} wrap>
            <FilterMenu
              label="Status"
              value={status}
              options={STATUS_OPTIONS}
              onChange={setStatus}
              allLabel="All statuses"
            />
            {connections.length > 1 && (
              <FilterMenu
                label="Shop"
                value={connectionId}
                options={connections.map((c) => ({ value: c.id, label: c.shopName }))}
                onChange={setConnectionId}
                allLabel="All shops"
              />
            )}
          </Row>
          {query.isError && rows.length === 0 ? (
            <QueryBoundary
              isPending={false}
              isError
              error={query.error}
              refetch={() => query.refetch()}
            >
              {null}
            </QueryBoundary>
          ) : (
            <DataTable
              label="TikTok orders"
              columns={orderColumns}
              rows={rows}
              rowKey={(o) => o.id}
              loading={query.isPending}
              empty={
                <EmptyState icon="box" title="No TikTok orders here">
                  <Stack gap={2}>
                    <Text>
                      Orders arrive from TikTok by themselves: TikTok sends a notification when an
                      order changes, and OrderLoop also checks every 10 minutes. Nothing is changed
                      on TikTok.
                    </Text>
                    {can('integrations:read') && (
                      <Link href={TIKTOK_PATH} variant="inline">
                        Go to the TikTok Shop integration
                      </Link>
                    )}
                  </Stack>
                </EmptyState>
              }
              onRowPress={(o) => navigation.push(`/tiktok-orders/${o.id}`)}
              rowLabel={(o) => `TikTok order ${o.externalOrderId}`}
              renderCard={(o) => <OrderCard order={o} />}
              footer={
                <LoadMore
                  hasNext={query.hasNextPage}
                  loading={query.isFetchingNextPage}
                  onPress={() => void query.fetchNextPage()}
                />
              }
            />
          )}
        </Stack>
      )}
    </Stack>
  );
}
