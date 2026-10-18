import type { Dashboard, DashboardPeriod } from '@orderloop/contracts';
import { ORDER_STATUS_VALUES } from '@orderloop/contracts';
import {
  Alert,
  BarChart,
  Badge,
  Button,
  EmptyState,
  FieldGrid,
  Link,
  PageHeader,
  Row,
  Section,
  Stack,
  StatCard,
  Tabs,
  Text,
} from '@orderloop/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { OrderStatusBadge } from '../components/OrderStatusBadge';
import { QueryBoundary } from '../components/QueryBoundary';
import { formatWhen, variantLabel } from '../format';
import { formatPrice } from '../money';
import { STATUS_LABEL } from '../orders';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];
const PERIOD_WORDS: Record<DashboardPeriod, string> = {
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
};

const shortDay = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const percent = (rate: number) => `${Math.round(rate * 100)}%`;

function Attention({ d }: { d: Dashboard }) {
  const a = d.attention;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const items = [
    a.pendingConfirmation > 0 && (
      <Link key="p" href="/orders?status=pending_confirmation">
        {`${plural(a.pendingConfirmation, 'order', 'orders')} waiting to be confirmed`}
      </Link>
    ),
    a.toShip > 0 && (
      <Link key="r" href="/orders?status=confirmed">
        {`${plural(a.toShip, 'confirmed order', 'confirmed orders')} to pack and ship`}
      </Link>
    ),
    a.deliveryFailed > 0 && (
      <Link key="f" href="/orders?status=delivery_failed">
        {`${plural(a.deliveryFailed, 'failed delivery', 'failed deliveries')} to follow up`}
      </Link>
    ),
    a.returnsOpen > 0 && (
      <Link key="rr" href="/orders?status=return_requested">
        {`${plural(a.returnsOpen, 'return', 'returns')} to receive`}
      </Link>
    ),
    d.lowStock.count > 0 && (
      <Link key="l" href="/inventory">
        {`${plural(d.lowStock.count, 'product', 'products')} running low on stock`}
      </Link>
    ),
  ].filter(Boolean);
  if (items.length === 0)
    return <Alert tone="success">Nothing needs your attention right now.</Alert>;
  return (
    <Alert tone="warning" title="Needs your attention">
      <Stack gap={1}>{items}</Stack>
    </Alert>
  );
}

function Profit({ d }: { d: Dashboard }) {
  const p = d.profit;
  if (!p.available)
    return (
      <Section
        title="Profit"
        description="Shown only when it can be worked out from your own prices."
      >
        <Text tone="muted">{p.reason}</Text>
      </Section>
    );
  return (
    <Section
      title="Estimated gross profit"
      description={`Delivered orders ${PERIOD_WORDS[d.period]}.`}
      actions={<Badge tone="warning">Estimate</Badge>}
    >
      <FieldGrid minWidth={180}>
        <StatCard
          label="Estimated gross profit"
          value={formatPrice(p.grossProfitMinor)}
          hint={`${p.deliveredOrders} delivered order${p.deliveredOrders === 1 ? '' : 's'}`}
        />
        <StatCard label="Item revenue" value={formatPrice(p.revenueMinor)} />
        <StatCard label="Cost of those items" value={formatPrice(p.costMinor)} />
      </FieldGrid>
      <Text variant="caption" tone="muted">
        {p.basis}
      </Text>
    </Section>
  );
}

/**
 * The seller's morning view. Every number comes from `GET /v1/dashboard`; nothing is computed or invented in the browser
 * (apart from formatting). Each figure links to the list it came from.
 */
export function DashboardScreen() {
  const api = useApi();
  const can = useCan();
  const [period, setPeriod] = useState<DashboardPeriod>('7d');
  const query = useQuery({
    queryKey: ['dashboard', period],
    queryFn: () => api.dashboard.get(period),
    // Keep showing the previous period while the next one loads, instead of flashing a spinner.
    placeholderData: keepPreviousData,
  });
  const d = query.data;
  const brandNew = d && d.orders.total === 0 && d.recentActivity.length === 0;

  return (
    <Stack gap={5}>
      <PageHeader
        title="Dashboard"
        description="How the business is doing. Figures are for orders created in the chosen period, in your business time zone."
        actions={
          <Row gap={2} wrap>
            <Button
              variant="secondary"
              loading={query.isFetching && !query.isPending}
              onPress={() => query.refetch()}
            >
              Refresh
            </Button>
            {can('orders:write') && <Button href="/orders/new">New order</Button>}
          </Row>
        }
      />
      <Tabs
        label="Period"
        items={PERIODS}
        value={period}
        onChange={(v) => setPeriod(v as DashboardPeriod)}
      />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading the dashboard">
        {d && (
          <Stack gap={5}>
            {brandNew && (
              <EmptyState
                title="Welcome. Your dashboard fills in as you work."
                action={
                  <Row gap={2} wrap justify="center">
                    <Button href="/products/new">Add a product</Button>
                    <Button variant="secondary" href="/inventory">
                      Receive stock
                    </Button>
                    {can('orders:write') && (
                      <Button variant="secondary" href="/orders/new">
                        Take an order
                      </Button>
                    )}
                  </Row>
                }
              >
                Add your products, put stock on the shelf, then take your first order. Orders, sales
                and delivery figures appear here.
              </EmptyState>
            )}
            <Attention d={d} />

            <FieldGrid minWidth={190}>
              <StatCard
                label="Orders"
                value={String(d.orders.total)}
                hint={`created ${PERIOD_WORDS[d.period]}`}
                footer={<Link href={`/orders?from=${d.from}&to=${d.to}`}>View orders</Link>}
              />
              <StatCard
                label="Sales"
                value={formatPrice(d.sales.orderedMinor)}
                hint={`${d.sales.ordersCounted} order${d.sales.ordersCounted === 1 ? '' : 's'}, cancelled ones left out`}
              />
              <StatCard
                label="Delivered sales"
                value={formatPrice(d.sales.deliveredMinor)}
                hint={`${d.delivery.delivered} delivered`}
                footer={
                  <Link href={`/orders?status=delivered&from=${d.from}&to=${d.to}`}>
                    View delivered
                  </Link>
                }
              />
              <StatCard
                label="Cash on delivery out"
                value={formatPrice(d.sales.codOutForDeliveryMinor)}
                hint="for couriers to collect on orders on their way"
              />
              <StatCard
                label="Average order"
                value={
                  d.sales.averageOrderMinor === null ? '—' : formatPrice(d.sales.averageOrderMinor)
                }
              />
              <StatCard
                label="Delivery success"
                value={d.delivery.successRate === null ? '—' : percent(d.delivery.successRate)}
                hint={
                  d.delivery.successRate === null
                    ? 'appears once an order is delivered, fails or returns'
                    : 'delivered out of delivered, failed and returned'
                }
              />
            </FieldGrid>

            <FieldGrid minWidth={300}>
              <Section title="Orders per day">
                <BarChart
                  bars={d.daily.map((x) => ({
                    key: x.date,
                    label: shortDay(x.date),
                    value: x.orders,
                  }))}
                  summary={`Orders per day, ${shortDay(d.from)} to ${shortDay(d.to)}: ${d.daily.map((x) => `${shortDay(x.date)} ${x.orders}`).join(', ')}.`}
                />
              </Section>
              <Section title="Sales per day">
                <BarChart
                  bars={d.daily.map((x) => ({
                    key: x.date,
                    label: shortDay(x.date),
                    value: x.orderedMinor,
                  }))}
                  summary={`Sales per day, ${shortDay(d.from)} to ${shortDay(d.to)}: ${d.daily.map((x) => `${shortDay(x.date)} ${formatPrice(x.orderedMinor)}`).join(', ')}.`}
                />
              </Section>
            </FieldGrid>

            <FieldGrid minWidth={300}>
              <Section
                title="Orders by status"
                description={`Where the ${d.orders.total} order${d.orders.total === 1 ? '' : 's'} created ${PERIOD_WORDS[d.period]} are now.`}
              >
                <Stack gap={2}>
                  {ORDER_STATUS_VALUES.map((s) => (
                    <Row key={s} gap={2} justify="between">
                      <Link href={`/orders?status=${s}&from=${d.from}&to=${d.to}`}>
                        {STATUS_LABEL[s]}
                      </Link>
                      <Text weight="medium">{String(d.orders.byStatus[s])}</Text>
                    </Row>
                  ))}
                </Stack>
              </Section>
              <Section
                title="Low stock"
                description="Products at or below their reorder point, all locations together."
                actions={d.lowStock.count > 0 ? <Link href="/inventory">See all</Link> : undefined}
              >
                {d.lowStock.items.length === 0 ? (
                  <Text tone="muted">Nothing is running low.</Text>
                ) : (
                  <Stack gap={2}>
                    {d.lowStock.items.map((i) => (
                      <Row key={i.variantId} gap={2} justify="between" wrap>
                        <Stack gap={1} grow>
                          <Text weight="medium">{variantLabel(i.productName, i.variantName)}</Text>
                          <Text
                            variant="caption"
                            tone="muted"
                          >{`${i.sku} · reorder at ${i.reorderPoint}`}</Text>
                        </Stack>
                        <Badge
                          tone={i.available <= 0 ? 'error' : 'warning'}
                        >{`${i.available} available`}</Badge>
                      </Row>
                    ))}
                    {d.lowStock.count > d.lowStock.items.length && (
                      <Text
                        variant="caption"
                        tone="muted"
                      >{`and ${d.lowStock.count - d.lowStock.items.length} more`}</Text>
                    )}
                  </Stack>
                )}
              </Section>
            </FieldGrid>

            <Profit d={d} />

            <Section title="Recent activity" description="The latest order changes, newest first.">
              {d.recentActivity.length === 0 ? (
                <Text tone="muted">Nothing has happened yet.</Text>
              ) : (
                <Stack gap={3}>
                  {d.recentActivity.map((a) => (
                    <Row key={a.id} gap={2} wrap>
                      <Link
                        href={`/orders/${a.orderId}`}
                        weight="medium"
                      >{`Order #${a.orderNumber}`}</Link>
                      <OrderStatusBadge status={a.toStatus} />
                      <Text variant="caption" tone="muted">
                        {`${formatWhen(a.at)}${a.actorName ? ` · ${a.actorName}` : ''}`}
                      </Text>
                      {a.reason && a.fromStatus && <Text variant="caption">{a.reason}</Text>}
                    </Row>
                  ))}
                </Stack>
              )}
            </Section>
            <Text
              variant="caption"
              tone="muted"
            >{`Updated ${formatWhen(d.generatedAt)}. ${d.timezone} time.`}</Text>
          </Stack>
        )}
      </QueryBoundary>
    </Stack>
  );
}
