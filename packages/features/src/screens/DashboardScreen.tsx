import { formatBdPhone } from '@orderloop/domain';
import type { Dashboard, DashboardPeriod, OrderSummary } from '@orderloop/contracts';
import { ORDER_STATUS_VALUES } from '@orderloop/contracts';
import {
  AreaChart,
  Badge,
  Button,
  Card,
  chartColors,
  DataTable,
  DonutChart,
  EmptyState,
  Grid,
  Icon,
  Link,
  PageHeader,
  PageStack,
  ProgressBar,
  Row,
  Section,
  Skeleton,
  Split,
  Stack,
  StatCard,
  Tabs,
  Text,
  KeyValueList,
  type Column,
  type IconName,
  useBreakpoint,
} from '@orderloop/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import {
  greeting,
  PERIOD_ITEMS,
  PERIOD_WORDS,
  percent,
  percentOf,
  useAnalytics,
} from '../analytics';
import { useAuth } from '../auth';
import { OrderStatusBadge } from '../components/OrderStatusBadge';
import { PaymentBadge } from '../components/PaymentBadge';
import { QueryBoundary } from '../components/QueryBoundary';
import { SalesProfitChart } from '../components/SalesProfitChart';
import { SectionBoundary } from '../components/SectionBoundary';
import { COURIER_NAME } from '../couriers';
import {
  formatDayTime,
  formatShortDay,
  formatWeekdayDay,
  formatWhen,
  variantLabel,
} from '../format';
import { formatPrice, formatPriceShort } from '../money';
import { STATUS_LABEL } from '../orders';
import { QuickActions } from '../components/QuickActions';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

/** Colours for the order-status ring. Several statuses share a hue; the legend names each one. */
const STATUS_COLOR: Record<(typeof ORDER_STATUS_VALUES)[number], string> = {
  delivered: chartColors[1],
  shipped: chartColors[0],
  in_transit: chartColors[0],
  confirmed: chartColors[4],
  ready_to_ship: chartColors[4],
  pending_confirmation: chartColors[2],
  delivery_failed: chartColors[3],
  return_requested: chartColors[2],
  returned: chartColors[3],
  cancelled: chartColors[5],
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const longDate = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);

function DashboardSkeleton() {
  return (
    <View role="status" aria-label="Loading the dashboard">
      <PageStack>
        <Grid columns={{ mobile: 2, tablet: 3, desktop: 6 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <Card key={i} variant="outlined" padding="md">
              <Stack gap={3}>
                <Skeleton width="60%" height={14} />
                <Skeleton width="50%" height={28} />
                <Skeleton width="70%" height={12} />
              </Stack>
            </Card>
          ))}
        </Grid>
        <Skeleton height={240} radius={12} />
        <Skeleton height={160} radius={12} />
      </PageStack>
    </View>
  );
}

/** One thing waiting for a person: an icon, a link that says what, and a line of why. */
function AttentionItem({
  icon,
  tone,
  href,
  title,
  hint,
}: {
  icon: IconName;
  tone: 'error' | 'warning';
  href: string;
  title: string;
  hint: string;
}) {
  return (
    <Row gap={3} align="start">
      <Badge tone={tone}>
        <Icon name={icon} size={12} />
      </Badge>
      <Stack gap={1} grow>
        <Link href={href} weight="medium">
          {title}
        </Link>
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      </Stack>
    </Row>
  );
}

function Attention({ d }: { d: Dashboard }) {
  const a = d.attention;
  const orders = a.pendingConfirmation + a.toShip + a.deliveryFailed + a.returnsOpen;
  const items = [
    a.pendingConfirmation > 0 && (
      <AttentionItem
        key="p"
        icon="clock"
        tone="warning"
        href="/orders?status=pending_confirmation"
        title={`${plural(a.pendingConfirmation, 'order', 'orders')} waiting to be confirmed`}
        hint="Confirm them so stock is set aside."
      />
    ),
    a.toShip > 0 && (
      <AttentionItem
        key="r"
        icon="box"
        tone="warning"
        href="/orders?status=confirmed"
        title={`${plural(a.toShip, 'confirmed order', 'confirmed orders')} to pack and ship`}
        hint="Check stock, pack and book a courier."
      />
    ),
    a.deliveryFailed > 0 && (
      <AttentionItem
        key="f"
        icon="alert"
        tone="error"
        href="/orders?status=delivery_failed"
        title={`${plural(a.deliveryFailed, 'failed delivery', 'failed deliveries')} to follow up`}
        hint="Call the customer, then rebook or cancel."
      />
    ),
    a.returnsOpen > 0 && (
      <AttentionItem
        key="rr"
        icon="return"
        tone="error"
        href="/orders?status=return_requested"
        title={`${plural(a.returnsOpen, 'return', 'returns')} to receive`}
        hint="Inspect the parcel and restock what is sellable."
      />
    ),
    d.lowStock.count > 0 && (
      <AttentionItem
        key="l"
        icon="layers"
        tone="warning"
        href="/products"
        title={`${plural(d.lowStock.count, 'product', 'products')} running low on stock`}
        hint="Receive stock before you run out."
      />
    ),
  ].filter(Boolean);
  return (
    <Section
      title={
        orders > 0 ? `Needs attention · ${plural(orders, 'order', 'orders')}` : 'Needs attention'
      }
      actions={
        orders > 0 ? (
          <Button variant="link" href="/orders">
            View all
          </Button>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <Text tone="muted">Nothing needs your attention right now.</Text>
      ) : (
        <Grid columns={{ mobile: 1, tablet: 2, desktop: 3 }}>{items}</Grid>
      )}
    </Section>
  );
}

function SalesChart({ d, finance }: { d: Dashboard; finance: boolean }) {
  const analytics = useAnalytics(d.from, d.to, finance);
  return (
    <Section
      title={finance ? 'Sales & profit' : 'Sales'}
      description={
        finance
          ? `${PERIOD_WORDS[d.period]} · delivered orders only`
          : `${PERIOD_WORDS[d.period]} · orders placed, cancelled ones left out`
      }
    >
      {finance ? (
        <SectionBoundary
          {...analytics}
          refetch={() => analytics.refetch()}
          label="Loading the sales chart"
          lines={1}
          height={220}
        >
          {analytics.data && (
            <SalesProfitChart days={analytics.data.daily} from={d.from} to={d.to} />
          )}
        </SectionBoundary>
      ) : (
        <AreaChart
          title={`Sales per day, ${formatShortDay(d.from)} to ${formatShortDay(d.to)}`}
          labels={d.daily.map((x) => formatShortDay(x.date))}
          tooltipTitle={(i) => formatWeekdayDay(d.daily[i]!.date)}
          series={[
            {
              key: 'sales',
              label: 'Ordered sales',
              values: d.daily.map((x) => x.orderedMinor),
              area: true,
            },
          ]}
          format={formatPrice}
          formatAxis={formatPriceShort}
        />
      )}
    </Section>
  );
}

function StatusCard({ d }: { d: Dashboard }) {
  const total = d.orders.total;
  const rows = ORDER_STATUS_VALUES.filter((s) => d.orders.byStatus[s] > 0);
  return (
    <Section title="Order status" description={`Orders created ${PERIOD_WORDS[d.period]}`}>
      {total === 0 ? (
        <Text tone="muted">No orders in this period yet.</Text>
      ) : (
        <Stack gap={4} align="center">
          <DonutChart
            title={`Orders by status: ${rows.map((s) => `${STATUS_LABEL[s]} ${d.orders.byStatus[s]}`).join(', ')}`}
            centerValue={String(total)}
            centerLabel={total === 1 ? 'order' : 'orders'}
            slices={rows.map((s) => ({
              key: s,
              label: STATUS_LABEL[s],
              value: d.orders.byStatus[s],
              color: STATUS_COLOR[s],
            }))}
          />
          <Stack gap={2} style={{ alignSelf: 'stretch' }}>
            {rows.map((s) => (
              <Row key={s} gap={2} justify="between">
                <Row gap={2}>
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: STATUS_COLOR[s],
                    }}
                  />
                  <Link
                    href={`/orders?status=${s}&from=${d.from}&to=${d.to}`}
                    variant="plain"
                    style={{ textDecorationLine: 'underline' }}
                  >
                    {STATUS_LABEL[s]}
                  </Link>
                </Row>
                <Text numeric tone="muted">
                  {`${d.orders.byStatus[s]} · ${percentOf(d.orders.byStatus[s], total).replace('.0%', '%')}`}
                </Text>
              </Row>
            ))}
          </Stack>
        </Stack>
      )}
    </Section>
  );
}

function RecentOrders() {
  const api = useApi();
  const query = useQuery({
    queryKey: ['orders', 'recent'],
    queryFn: () => api.orders.list({ limit: 5 }),
  });
  const columns: Column<OrderSummary>[] = [
    {
      key: 'order',
      header: 'Order',
      minWidth: 90,
      render: (o) => (
        <Link href={`/orders/${o.id}`} weight="medium">
          {`#${o.orderNumber}`}
        </Link>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      flex: 2,
      minWidth: 140,
      render: (o) => (
        <Stack gap={1}>
          <Text weight="medium">{o.customerName}</Text>
          <Text variant="caption" tone="muted">
            {formatBdPhone(o.phone)}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'products',
      header: 'Products',
      flex: 2,
      minWidth: 140,
      show: 'desktop',
      render: (o) => o.itemsSummary,
    },
    {
      key: 'payment',
      header: 'Payment',
      flex: 2,
      minWidth: 140,
      render: (o) => <PaymentBadge state={o.payment} />,
    },
    {
      key: 'status',
      header: 'Status',
      flex: 2,
      minWidth: 130,
      render: (o) => <OrderStatusBadge status={o.status} />,
    },
    {
      key: 'courier',
      header: 'Courier',
      minWidth: 80,
      show: 'desktop',
      render: (o) => (o.courier ? COURIER_NAME[o.courier.provider] : 'Not booked'),
    },
    {
      key: 'date',
      header: 'Date',
      minWidth: 110,
      render: (o) => formatDayTime(o.createdAt),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      minWidth: 96,
      render: (o) => <Text numeric>{formatPrice(o.totalMinor)}</Text>,
    },
  ];
  return (
    <Section
      title="Recent orders"
      actions={
        <Button variant="link" href="/orders">
          View all orders
        </Button>
      }
    >
      <SectionBoundary
        {...query}
        refetch={() => query.refetch()}
        label="Loading recent orders"
        lines={5}
        height={40}
      >
        <DataTable
          label="Recent orders"
          columns={columns}
          rows={query.data?.items ?? []}
          rowKey={(o) => o.id}
          empty={
            <EmptyState title="No orders yet" icon="box">
              Orders you take will show up here.
            </EmptyState>
          }
          renderCard={(o) => (
            <Stack gap={2}>
              <Row justify="between" gap={2}>
                <Link href={`/orders/${o.id}`} weight="medium">
                  {`#${o.orderNumber}`}
                </Link>
                <OrderStatusBadge status={o.status} />
              </Row>
              <Text weight="medium">{o.customerName}</Text>
              <Text variant="caption" tone="muted">
                {o.itemsSummary}
              </Text>
              <Row justify="between" gap={2} wrap>
                <PaymentBadge state={o.payment} />
                <Text numeric weight="medium">
                  {formatPrice(o.totalMinor)}
                </Text>
              </Row>
            </Stack>
          )}
        />
      </SectionBoundary>
    </Section>
  );
}

function CourierPerformance() {
  const api = useApi();
  const query = useQuery({
    queryKey: ['shipments', 'stats'],
    queryFn: () => api.shipments.stats(),
  });
  const s = query.data;
  const providers = s?.providers.filter((p) => p.shipments > 0) ?? [];
  return (
    <Section
      title="Courier performance"
      description={s ? `Last ${s.statsDays} days` : undefined}
      actions={
        <Button variant="link" href="/couriers">
          Couriers
        </Button>
      }
    >
      <SectionBoundary
        {...query}
        refetch={() => query.refetch()}
        label="Loading courier performance"
      >
        {s && providers.length === 0 ? (
          <Text tone="muted">
            No shipments yet. Book a courier on a confirmed order to see how each one does.
          </Text>
        ) : (
          s && (
            <Stack gap={4}>
              {providers.map((p) => (
                <Stack key={p.provider} gap={2}>
                  <Row justify="between" gap={3}>
                    <Stack gap={1} grow>
                      <Text weight="medium">
                        {COURIER_NAME[p.provider] + (p.simulated ? ' (simulated)' : '')}
                      </Text>
                      <Text variant="caption" tone="muted">
                        {`${plural(p.shipments, 'shipment', 'shipments')}${p.avgDeliveryDays === null ? '' : ` · avg ${Math.round(p.avgDeliveryDays * 10) / 10} days`}`}
                      </Text>
                    </Stack>
                    <Text numeric weight="medium">
                      {p.deliveredRate === null ? '—' : percent(p.deliveredRate)}
                    </Text>
                  </Row>
                  <ProgressBar
                    value={p.deliveredRate ?? 0}
                    label={`${COURIER_NAME[p.provider]} delivered rate`}
                  />
                </Stack>
              ))}
              <Text variant="caption" tone="muted">
                {`Overall: ${s.delivered} delivered, ${s.returned} returned, ${s.onTheWay} on the way`}
              </Text>
            </Stack>
          )
        )}
      </SectionBoundary>
    </Section>
  );
}

function CodSettlement() {
  const api = useApi();
  const query = useQuery({
    queryKey: ['finance', 'outstanding'],
    queryFn: () => api.finance.outstanding(),
  });
  const o = query.data;
  return (
    <Section
      title="COD settlement"
      actions={
        <Button variant="link" href="/cod">
          Reconcile
        </Button>
      }
    >
      <SectionBoundary {...query} refetch={() => query.refetch()} label="Loading COD settlement">
        {o && (
          <Stack gap={3}>
            <KeyValueList
              layout="inline"
              items={[
                { label: 'Expected · delivered', value: formatPrice(o.deliveredExpectedMinor) },
                {
                  label: 'Collected · per statements',
                  value: formatPrice(o.deliveredCollectedMinor),
                },
                {
                  label: 'COD outstanding',
                  value: formatPrice(o.outstandingMinor),
                  emphasis: true,
                },
                {
                  label: 'Still with couriers',
                  value: formatPrice(o.onTheWayMinor),
                  tone: 'muted',
                },
              ]}
            />
            <Text variant="caption" tone="muted">
              Delivered is not paid: cash counts as collected only when a courier statement says so.
            </Text>
          </Stack>
        )}
      </SectionBoundary>
    </Section>
  );
}

function LowStock({ d }: { d: Dashboard }) {
  return (
    <Section
      title="Low stock"
      description="At or below the reorder point"
      actions={
        d.lowStock.count > 0 ? (
          <Button variant="link" href="/products">
            See all
          </Button>
        ) : undefined
      }
    >
      {d.lowStock.items.length === 0 ? (
        <Text tone="muted">Nothing is running low.</Text>
      ) : (
        <Stack gap={3}>
          {d.lowStock.items.map((i) => (
            <Row key={i.variantId} gap={2} justify="between" wrap>
              <Stack gap={1} grow>
                <Text weight="medium">{variantLabel(i.productName, i.variantName)}</Text>
                <Text
                  variant="caption"
                  tone="muted"
                >{`${i.sku} · reorder at ${i.reorderPoint}`}</Text>
              </Stack>
              <Badge tone={i.available <= 0 ? 'error' : 'warning'} dot>
                {`${i.available} left`}
              </Badge>
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
      <Button variant="secondary" icon="plus" href="/products">
        Receive stock
      </Button>
    </Section>
  );
}

/**
 * The seller's morning view. Orders, delivery and sales come from `GET /v1/dashboard`; cash and profit from the finance
 * endpoints (only for roles that may read finance). Nothing is computed or invented in the browser beyond formatting.
 */
export function DashboardScreen() {
  const api = useApi();
  const can = useCan();
  const { isMobile } = useBreakpoint();
  const { session } = useAuth();
  const [period, setPeriod] = useState<DashboardPeriod>('7d');
  const canFinance = can('finance:read');
  const query = useQuery({
    queryKey: ['dashboard', period],
    queryFn: () => api.dashboard.get(period),
    // Keep showing the previous period while the next one loads, instead of flashing a skeleton.
    placeholderData: keepPreviousData,
  });
  const d = query.data;
  const range = d ? { from: d.from, to: d.to } : null;
  const outstanding = useQuery({
    queryKey: ['finance', 'outstanding'],
    queryFn: () => api.finance.outstanding(),
    enabled: canFinance,
  });
  const summary = useQuery({
    queryKey: ['finance', 'summary', range?.from, range?.to],
    queryFn: () => api.finance.summary({ from: range!.from, to: range!.to }),
    enabled: canFinance && !!range,
  });
  const brandNew = d && d.orders.total === 0 && d.recentActivity.length === 0;
  const firstName = session?.user.name.trim().split(/\s+/)[0];

  const money = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : formatPrice(value);

  return (
    <PageStack>
      <PageHeader
        title={firstName ? `${greeting()}, ${firstName}` : greeting()}
        description={`${longDate(new Date())}${session ? ` · ${session.tenant.name}` : ''}`}
        actions={
          <>
            <Tabs
              variant="segmented"
              label="Period"
              items={PERIOD_ITEMS}
              value={period}
              onChange={(v) => setPeriod(v as DashboardPeriod)}
            />
            {can('orders:write') && (
              <Button icon="plus" href="/orders/new">
                Create order
              </Button>
            )}
          </>
        }
      />
      {isMobile && <QuickActions />}
      {query.isPending ? (
        <DashboardSkeleton />
      ) : (
        <QueryBoundary
          isPending={false}
          isError={query.isError}
          error={query.error}
          refetch={() => query.refetch()}
        >
          {d && (
            <PageStack>
              {brandNew && (
                <EmptyState
                  title="Welcome. Your dashboard fills in as you work."
                  icon="home"
                  action={
                    <Row gap={2} wrap justify="center">
                      <Button href="/products/new">Add a product</Button>
                      <Button variant="secondary" href="/products">
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
                  Add your products, put stock on the shelf, then take your first order. Orders,
                  sales and delivery figures appear here.
                </EmptyState>
              )}

              <Grid columns={{ mobile: 2, tablet: 3, desktop: 6 }}>
                <StatCard
                  icon="box"
                  label="Total orders"
                  value={String(d.orders.total)}
                  hint={`created ${PERIOD_WORDS[d.period]}`}
                />
                <StatCard
                  icon="check-circle"
                  label="Delivered orders"
                  value={String(d.delivery.delivered)}
                  hint={`of ${d.orders.total} created`}
                />
                <StatCard
                  icon="truck"
                  label="Delivery success"
                  value={d.delivery.successRate === null ? '—' : percent(d.delivery.successRate)}
                  hint={
                    d.delivery.successRate === null
                      ? 'appears once an order is delivered, fails or returns'
                      : 'delivered out of delivered, failed and returned'
                  }
                />
                <StatCard
                  icon="wallet"
                  label="Revenue (delivered)"
                  value={formatPrice(d.sales.deliveredMinor)}
                  hint="delivered orders, not the same as paid"
                />
                {canFinance ? (
                  <StatCard
                    icon="wallet"
                    tone="warning"
                    label="COD outstanding"
                    value={money(outstanding.data?.outstandingMinor)}
                    hint={
                      outstanding.isError
                        ? 'could not be loaded'
                        : 'delivered, not yet on a courier statement'
                    }
                  />
                ) : (
                  <StatCard
                    icon="wallet"
                    label="Cash on delivery out"
                    value={formatPrice(d.sales.codOutForDeliveryMinor)}
                    hint="for couriers to collect on orders on their way"
                  />
                )}
                {canFinance ? (
                  <StatCard
                    icon="bar-chart"
                    label="Net profit"
                    value={money(summary.data?.estimatedProfitMinor)}
                    hint={
                      summary.isError
                        ? 'could not be loaded'
                        : summary.data
                          ? summary.data.estimatedProfitMinor === null
                            ? (summary.data.profitWithheldReason ?? 'cannot be worked out yet')
                            : 'estimate, after recorded costs'
                          : undefined
                    }
                    footer={
                      <Link
                        href="/analytics"
                        variant="plain"
                        style={{ textDecorationLine: 'underline' }}
                      >
                        See how it is worked out
                      </Link>
                    }
                  />
                ) : (
                  <StatCard
                    icon="bar-chart"
                    label="Average order"
                    value={
                      d.sales.averageOrderMinor === null
                        ? '—'
                        : formatPrice(d.sales.averageOrderMinor)
                    }
                    hint="orders placed, cancelled ones left out"
                  />
                )}
              </Grid>
              <Row gap={2} align="start">
                <Icon name="info" size={14} />
                <Text variant="caption" tone="muted" style={{ flexShrink: 1 }}>
                  {canFinance
                    ? 'Revenue counts delivered orders only; delivered is not paid. COD outstanding is cash couriers still owe you until a statement confirms it. Net profit is delivered revenue minus product cost, courier charges and recorded costs: unsettled COD is never profit.'
                    : 'Revenue counts delivered orders only; delivered is not the same as paid. Cash on delivery out is what couriers should collect on orders still on their way.'}
                </Text>
              </Row>

              <Split
                asideWidth={380}
                main={<SalesChart d={d} finance={canFinance} />}
                aside={<StatusCard d={d} />}
              />

              <Attention d={d} />
              <RecentOrders />

              <Grid
                columns={{
                  mobile: 1,
                  tablet: 2,
                  desktop: can('couriers:read') && canFinance ? 3 : 2,
                }}
              >
                {can('couriers:read') ? <CourierPerformance /> : null}
                {canFinance ? <CodSettlement /> : null}
                <LowStock d={d} />
              </Grid>

              <Text variant="caption" tone="muted">
                {`Updated ${formatWhen(d.generatedAt)}. ${d.timezone} time.`}
              </Text>
            </PageStack>
          )}
        </QueryBoundary>
      )}
    </PageStack>
  );
}
