import type {
  Analytics,
  DashboardPeriod,
  FinanceSummary,
  OutstandingCod,
} from '@orderloop/contracts';
import {
  Alert,
  Button,
  chartColors,
  DataTable,
  EmptyState,
  Grid,
  KeyValueList,
  PageHeader,
  PageStack,
  ProgressBar,
  Row,
  Section,
  Split,
  Stack,
  StatCard,
  Tabs,
  Text,
  WaterfallChart,
  type Column,
  type WaterfallStep,
} from '@orderloop/ui';
import { useState } from 'react';
import {
  costLines,
  deliveredRevenue,
  figureMinor,
  figureOf,
  percent,
  percentOf,
  PERIOD_ITEMS,
  periodRange,
  profitMargin,
  rangeInWords,
  useAnalytics,
  type CostLine,
} from '../analytics';
import { CostsCard } from '../components/CostsCard';
import { SalesProfitChart } from '../components/SalesProfitChart';
import { SectionBoundary } from '../components/SectionBoundary';
import { SOURCE_LABEL, useFinanceSummary, useOutstanding } from '../finance';
import { variantLabel } from '../format';
import { formatPrice } from '../money';
import { SOURCE_LABEL as CHANNEL_LABEL } from '../orders';
import { useCan } from '../permissions';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SOURCES_MIXED = `${SOURCE_LABEL.settlements ?? ''} and ${(SOURCE_LABEL.manual_costs ?? '').toLowerCase()}`;

/** Where a figure comes from, small and muted: every number on this screen carries one. */
function Source({ children }: { children: string }) {
  return (
    <Text variant="caption" tone="muted">
      {children}
    </Text>
  );
}

/** A figure's hint line in a KPI card: what it counts, then where it comes from. */
function Hint({ what, source }: { what: string; source: string }) {
  return (
    <Stack gap={1}>
      <Text variant="caption" tone="muted">
        {what}
      </Text>
      <Source>{source}</Source>
    </Stack>
  );
}

const src = (summary: FinanceSummary, key: string, fallback = 'orders') =>
  SOURCE_LABEL[figureOf(summary, key)?.source ?? fallback] ?? '';

// ---- waterfall --------------------------------------------------------------------------------------------------------------

/** Gross sales down to net profit. Costs are only drawn when profit can be worked out; otherwise it stops at delivered revenue. */
export function waterfallSteps(
  summary: FinanceSummary,
  analytics: Analytics,
  costs: CostLine[] | null,
): WaterfallStep[] {
  const revenue = deliveredRevenue(summary);
  const steps: WaterfallStep[] = [
    {
      key: 'gross',
      label: 'Gross sales',
      value: figureMinor(summary, 'sales'),
      kind: 'total',
      color: chartColors[5],
    },
    {
      key: 'notDelivered',
      label: 'Not delivered',
      value: analytics.notDeliveredMinor,
      kind: 'minus',
      color: chartColors[5],
    },
    { key: 'revenue', label: 'Delivered revenue', value: revenue, kind: 'total' },
  ];
  if (!costs || summary.estimatedProfitMinor === null) return steps;
  for (const c of costs) {
    steps.push({
      key: c.key,
      label: WATERFALL_LABEL[c.key] ?? c.label,
      value: Math.abs(c.amountMinor),
      kind: c.amountMinor < 0 ? 'plus' : 'minus',
    });
  }
  steps.push({
    key: 'profit',
    label: 'Net profit',
    value: summary.estimatedProfitMinor,
    kind: 'total',
    color: summary.estimatedProfitMinor < 0 ? chartColors[3] : chartColors[1],
  });
  return steps;
}
const WATERFALL_LABEL: Record<string, string> = {
  cogs: 'Product cost',
  courier_delivery: 'Courier fees',
  courier_cod_fee: 'COD fees',
  courier_return: 'Returns',
  ads: 'Ad spend',
  other: 'Other costs',
};

function Waterfall({
  summary,
  analytics,
  costs,
}: {
  summary: FinanceSummary;
  analytics: Analytics;
  costs: CostLine[] | null;
}) {
  const steps = waterfallSteps(summary, analytics, costs);
  const withheld = summary.estimatedProfitMinor === null || !costs;
  return (
    <Section
      title="Profit waterfall · from gross sales to net profit"
      description="Every bar is a line in the calculation on the right."
    >
      <WaterfallChart
        title={`Profit waterfall: ${steps.map((s) => `${s.label} ${formatPrice(s.value)}`).join(', ')}`}
        steps={steps}
        format={formatPrice}
      />
      {withheld && (
        <Alert tone="warning" title="Net profit is not shown">
          {summary.profitWithheldReason ??
            'Profit cannot be worked out yet, so the chart stops at delivered revenue.'}
        </Alert>
      )}
      <Text variant="caption" tone="muted">
        Gross sales are counted by the day an order was placed and revenue by the day it was
        delivered, so the two can differ at the edges of the period.
      </Text>
    </Section>
  );
}

// ---- how profit is calculated -----------------------------------------------------------------------------------------------

const costSource = (summary: FinanceSummary, c: CostLine): string =>
  c.figureKey
    ? src(summary, c.figureKey)
    : c.key === 'ads'
      ? (SOURCE_LABEL.manual_costs ?? '')
      : SOURCES_MIXED;

const Amount = ({ value, source }: { value: string; source: string }) => (
  <Stack gap={0} align="end" style={{ flexShrink: 1, minWidth: 0 }}>
    <Text numeric>{value}</Text>
    <Source>{source}</Source>
  </Stack>
);

function HowProfitIsCalculated({
  summary,
  analytics,
  costs,
}: {
  summary: FinanceSummary;
  analytics: Analytics;
  costs: CostLine[] | null;
}) {
  const [notes, setNotes] = useState(false);
  const revenue = deliveredRevenue(summary);
  const profit = summary.estimatedProfitMinor;
  const total = costs?.reduce((n, c) => n + c.amountMinor, 0) ?? 0;
  const margin = profitMargin(summary);
  const noted = [
    ...(['revenue_goods', 'revenue_delivery'] as const),
    ...((costs ?? []).flatMap((c) => (c.figureKey ? [c.figureKey] : [])) as string[]),
  ]
    .map((k) => figureOf(summary, k))
    .flatMap((f) => (f ? [f] : []));
  return (
    <Section
      title="How profit is calculated"
      description="Delivered revenue minus every cost, in order"
      actions={
        <Button variant="link" onPress={() => setNotes((v) => !v)}>
          {notes ? 'Hide what each figure counts' : 'What each figure counts'}
        </Button>
      }
    >
      <KeyValueList
        layout="inline"
        items={[
          {
            label: plural(analytics.deliveredOrders, 'delivered order', 'delivered orders'),
            value: <Amount value={formatPrice(revenue)} source={SOURCE_LABEL.orders ?? ''} />,
          },
          ...(costs ?? []).map((c) => ({
            label: `${c.label} (${percentOf(c.amountMinor, revenue)})`,
            value: (
              <Amount value={`−${formatPrice(c.amountMinor)}`} source={costSource(summary, c)} />
            ),
          })),
          ...(costs && profit !== null
            ? [
                {
                  label: 'Total costs',
                  emphasis: true,
                  value: (
                    <Text numeric variant="heading" align="right">{`−${formatPrice(total)}`}</Text>
                  ),
                },
                {
                  label: `Net profit${margin === null ? '' : ` · margin ${percent(margin)}`}`,
                  emphasis: true,
                  value: (
                    <Amount
                      value={formatPrice(profit)}
                      source={src(summary, 'estimated_profit', 'derived')}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
      {(profit === null || !costs) && (
        <Text tone="muted">
          {`Costs and net profit are not shown: ${summary.profitWithheldReason ?? 'product costs are missing.'}`}
        </Text>
      )}
      {notes && (
        <Stack gap={2}>
          {noted.map((f) => (
            <Text key={f.key} variant="caption" tone="muted">
              {`${f.label}: ${f.note}`}
            </Text>
          ))}
        </Stack>
      )}
    </Section>
  );
}

function NotCounted({
  summary,
  analytics,
  outstanding,
}: {
  summary: FinanceSummary;
  analytics: Analytics;
  outstanding: ReturnType<typeof useOutstanding>;
}) {
  const o: OutstandingCod | undefined = outstanding.data;
  const derived = SOURCE_LABEL.derived ?? '';
  const cancelled = figureOf(summary, 'cancelled');
  return (
    <Section title="Not counted as profit" variant="filled">
      <SectionBoundary
        {...outstanding}
        refetch={() => outstanding.refetch()}
        label="Loading outstanding COD"
        lines={2}
      >
        <KeyValueList
          layout="inline"
          items={[
            {
              label: 'Unsettled COD (delivered, awaiting statement)',
              value: <Amount value={formatPrice(o?.outstandingMinor ?? 0)} source={derived} />,
            },
            {
              label: 'COD still with couriers',
              value: <Amount value={formatPrice(o?.onTheWayMinor ?? 0)} source={derived} />,
            },
            {
              label: 'Orders placed but not delivered',
              value: (
                <Amount
                  value={formatPrice(analytics.notDeliveredMinor)}
                  source={SOURCE_LABEL.orders ?? ''}
                />
              ),
            },
            ...(cancelled
              ? [
                  {
                    label: 'Cancelled orders',
                    value: (
                      <Amount
                        value={formatPrice(cancelled.amountMinor)}
                        source={SOURCE_LABEL[cancelled.source] ?? ''}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />
      </SectionBoundary>
      <Text variant="caption" tone="muted">
        Unsettled COD is cash still to arrive, not earnings. Returned and cancelled orders are never
        revenue.
      </Text>
    </Section>
  );
}

// ---- channels and products --------------------------------------------------------------------------------------------------

function Channels({ analytics }: { analytics: Analytics }) {
  const total = analytics.channels.reduce((n, c) => n + c.revenueMinor, 0);
  const rows = [...analytics.channels].sort((a, b) => b.revenueMinor - a.revenueMinor);
  return (
    <Section
      title="Sales by channel"
      description={`Delivered revenue, ${rangeInWords(analytics.from, analytics.to)}`}
    >
      {rows.length === 0 ? (
        <Text tone="muted">No delivered orders in this period yet.</Text>
      ) : (
        <Stack gap={4}>
          {rows.map((c, i) => (
            <Stack key={c.source} gap={2}>
              <Row justify="between" gap={3}>
                <Text weight="medium">{CHANNEL_LABEL[c.source]}</Text>
                <Row gap={2}>
                  <Text numeric>{formatPrice(c.revenueMinor)}</Text>
                  <Text numeric variant="caption" tone="muted">
                    {percentOf(c.revenueMinor, total)}
                  </Text>
                </Row>
              </Row>
              <ProgressBar
                value={total > 0 ? c.revenueMinor / total : 0}
                color={chartColors[i % chartColors.length]}
                label={`${CHANNEL_LABEL[c.source]} share of delivered revenue`}
              />
              <Text variant="caption" tone="muted">
                {plural(c.orders, 'order', 'orders')}
              </Text>
            </Stack>
          ))}
          <Source>{SOURCE_LABEL.orders ?? ''}</Source>
        </Stack>
      )}
    </Section>
  );
}

interface ProductRow {
  key: string;
  name: string;
  units: number;
  revenue: number;
  cost: number | null;
  profit: number | null;
  /** Share of delivered revenue, 0..1. Null on the total row. */
  share: number | null;
  strong: boolean;
}

/** Top products, then "Other products" (the totals less the top ones) and the total. */
export function productRows(a: Analytics): ProductRow[] {
  const top: ProductRow[] = a.topProducts.map((p) => ({
    key: `${p.sku}-${p.variantName}`,
    name: variantLabel(p.productName, p.variantName),
    units: p.units,
    revenue: p.revenueMinor,
    cost: p.costMinor,
    profit: p.grossProfitMinor,
    share: a.totalRevenueMinor > 0 ? p.revenueMinor / a.totalRevenueMinor : 0,
    strong: false,
  }));
  const units = a.totalUnits - top.reduce((n, r) => n + r.units, 0);
  const revenue = a.totalRevenueMinor - top.reduce((n, r) => n + r.revenue, 0);
  const topCostsKnown = top.every((r) => r.cost !== null);
  const otherCost =
    a.totalCostMinor === null || !topCostsKnown
      ? null
      : a.totalCostMinor - top.reduce((n, r) => n + (r.cost ?? 0), 0);
  const rows = [...top];
  if (units > 0 || revenue > 0)
    rows.push({
      key: 'other',
      name: 'Other products',
      units,
      revenue,
      cost: otherCost,
      profit: otherCost === null ? null : revenue - otherCost,
      share: a.totalRevenueMinor > 0 ? revenue / a.totalRevenueMinor : 0,
      strong: false,
    });
  rows.push({
    key: 'total',
    name: 'Total · delivered',
    units: a.totalUnits,
    revenue: a.totalRevenueMinor,
    cost: a.totalCostMinor,
    profit: a.totalCostMinor === null ? null : a.totalRevenueMinor - a.totalCostMinor,
    share: null,
    strong: true,
  });
  return rows;
}

function Products({ analytics }: { analytics: Analytics }) {
  const rows = analytics.topProducts.length === 0 ? [] : productRows(analytics);
  const money = (n: number | null) => (n === null ? '—' : formatPrice(n));
  const cell = (r: ProductRow, text: string) => (
    <Text numeric weight={r.strong ? 'bold' : 'normal'}>
      {text}
    </Text>
  );
  const margin = (r: ProductRow) =>
    r.profit === null || r.revenue <= 0 ? '—' : percentOf(r.profit, r.revenue);
  const columns: Column<ProductRow>[] = [
    {
      key: 'name',
      header: 'Product',
      flex: 3,
      minWidth: 200,
      render: (r) => <Text weight={r.strong ? 'bold' : 'medium'}>{r.name}</Text>,
    },
    {
      key: 'units',
      header: 'Units',
      align: 'right',
      minWidth: 70,
      render: (r) => cell(r, String(r.units)),
    },
    {
      key: 'revenue',
      header: 'Revenue',
      align: 'right',
      minWidth: 110,
      render: (r) => cell(r, formatPrice(r.revenue)),
    },
    {
      key: 'cost',
      header: 'Product cost',
      align: 'right',
      minWidth: 110,
      show: 'wide',
      render: (r) => cell(r, money(r.cost)),
    },
    {
      key: 'profit',
      header: 'Gross profit',
      align: 'right',
      minWidth: 110,
      render: (r) => cell(r, money(r.profit)),
    },
    {
      key: 'margin',
      header: 'Margin',
      align: 'right',
      minWidth: 80,
      show: 'wide',
      render: (r) => cell(r, margin(r)),
    },
    {
      key: 'share',
      header: 'Share of revenue',
      minWidth: 150,
      show: 'desktop',
      render: (r) =>
        r.share === null ? null : (
          <Row gap={2} style={{ alignSelf: 'stretch' }}>
            <Stack grow>
              <ProgressBar value={r.share} label={`${r.name} share of delivered revenue`} />
            </Stack>
            <Text numeric variant="caption" tone="muted">
              {percent(r.share)}
            </Text>
          </Row>
        ),
    },
  ];
  return (
    <Section
      title="Best-selling products"
      description="Delivered orders · gross profit = revenue − product cost (before shipping, ads and other costs)"
    >
      <DataTable
        label="Best-selling products"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        empty={
          <EmptyState title="No delivered sales in this period" icon="box">
            Products appear here once an order has been delivered.
          </EmptyState>
        }
        renderCard={(r) => (
          <Stack gap={1}>
            <Text weight={r.strong ? 'bold' : 'medium'}>{r.name}</Text>
            <Row justify="between" gap={2}>
              <Text variant="caption" tone="muted">{`${r.units} units`}</Text>
              <Text numeric>{formatPrice(r.revenue)}</Text>
            </Row>
            <Text variant="caption" tone="muted">
              {`Gross profit ${money(r.profit)} · margin ${margin(r)}`}
            </Text>
          </Stack>
        )}
      />
      <Source>{`${SOURCE_LABEL.orders ?? ''} and ${(SOURCE_LABEL.catalog_costs ?? '').toLowerCase()}`}</Source>
    </Section>
  );
}

// ---- the screen -------------------------------------------------------------------------------------------------------------

function Body({
  summary,
  analytics,
  outstanding,
  from,
  to,
}: {
  summary: FinanceSummary;
  analytics: Analytics;
  outstanding: ReturnType<typeof useOutstanding>;
  from: string;
  to: string;
}) {
  const costs = costLines(summary);
  const revenue = deliveredRevenue(summary);
  const profit = summary.estimatedProfitMinor;
  const margin = profitMargin(summary);
  const missing = analytics.linesWithoutCost;
  return (
    <PageStack>
      {missing > 0 && (
        <Alert
          tone="warning"
          title={`${plural(missing, 'delivered line has', 'delivered lines have')} no cost price`}
          action={
            <Button variant="secondary" href="/products">
              Fix costs
            </Button>
          }
        >
          {profit === null
            ? 'Net profit cannot be worked out until these have a cost price.'
            : 'Profit may be overstated until these have a cost price.'}
        </Alert>
      )}
      <Grid columns={{ mobile: 2, tablet: 3, desktop: 6 }}>
        <StatCard
          icon="wallet"
          label="Gross sales"
          value={formatPrice(figureMinor(summary, 'sales'))}
          hint={
            <Hint what={`all ${analytics.placedOrders} orders`} source={src(summary, 'sales')} />
          }
        />
        <StatCard
          icon="check-circle"
          label="Delivered revenue"
          value={formatPrice(revenue)}
          hint={
            <Hint
              what={plural(analytics.deliveredOrders, 'order', 'orders')}
              source={src(summary, 'revenue_goods')}
            />
          }
        />
        <StatCard
          icon="bar-chart"
          label="Net profit"
          value={profit === null ? '—' : formatPrice(profit)}
          hint={
            <Hint
              what={
                profit === null
                  ? (summary.profitWithheldReason ?? 'not available')
                  : 'after all costs'
              }
              source={src(summary, 'estimated_profit', 'derived')}
            />
          }
        />
        <StatCard
          icon="trend-up"
          label="Profit margin"
          value={margin === null ? '—' : percent(margin)}
          hint={
            <Hint
              what={
                margin === null ? 'needs net profit and revenue' : 'net profit ÷ delivered revenue'
              }
              source={SOURCE_LABEL.derived ?? ''}
            />
          }
        />
        <StatCard
          icon="tag"
          label="Avg order value"
          value={
            analytics.averageOrderMinor === null ? '—' : formatPrice(analytics.averageOrderMinor)
          }
          hint={
            <Hint
              what={`revenue ÷ ${analytics.deliveredOrders}`}
              source={SOURCE_LABEL.orders ?? ''}
            />
          }
        />
        <StatCard
          icon="truck"
          label="Delivery success"
          value={
            analytics.deliverySuccessRate === null ? '—' : percent(analytics.deliverySuccessRate)
          }
          hint={
            <Hint
              what="delivered of delivered, failed and returned"
              source={SOURCE_LABEL.orders ?? ''}
            />
          }
        />
      </Grid>
      {analytics.deliveredOrders === 0 && (
        <Text tone="muted">
          No orders were delivered in this period, so revenue and profit are zero.
        </Text>
      )}

      <Split
        asideWidth={420}
        main={<Waterfall summary={summary} analytics={analytics} costs={costs} />}
        aside={
          <>
            <HowProfitIsCalculated summary={summary} analytics={analytics} costs={costs} />
            <NotCounted summary={summary} analytics={analytics} outstanding={outstanding} />
          </>
        }
      />

      <Split
        asideWidth={420}
        main={
          <Section
            title="Sales & profit"
            description={`${rangeInWords(from, to)} · delivered orders only`}
          >
            <SalesProfitChart days={analytics.daily} from={from} to={to} />
            <Source>{SOURCE_LABEL.orders ?? ''}</Source>
          </Section>
        }
        aside={<Channels analytics={analytics} />}
      />

      <Products analytics={analytics} />

      <CostsCard from={from} to={to} />

      <Section title="Read this before you trust the figures">
        <Stack gap={2}>
          {summary.caveats.map((c) => (
            <Text key={c} tone="muted">
              {c}
            </Text>
          ))}
          <Text tone="muted">
            Revenue, costs and profit count delivered orders only; discounts are already taken off
            revenue.
          </Text>
        </Stack>
      </Section>
    </PageStack>
  );
}

/**
 * Analytics and profit: where the money went between a sale and the profit, with every figure's source. Reads the finance
 * summary and analytics for the chosen period; never adds sales, cash and profit together.
 */
export function AnalyticsScreen() {
  const can = useCan();
  const [period, setPeriod] = useState<DashboardPeriod>('7d');
  const { from, to } = periodRange(period);
  const allowed = can('finance:read');
  const summary = useFinanceSummary(from, to);
  const analytics = useAnalytics(from, to);
  const outstanding = useOutstanding();
  return (
    <PageStack>
      <PageHeader
        title="Analytics & profit"
        description={`${rangeInWords(from, to)} · delivered orders unless stated · all amounts in BDT`}
        actions={
          <Tabs
            variant="segmented"
            label="Period"
            items={PERIOD_ITEMS}
            value={period}
            onChange={(v) => setPeriod(v as DashboardPeriod)}
          />
        }
      />
      {!allowed ? (
        <EmptyState title="Finance figures are not available to your role" icon="lock">
          Ask the owner of the business if you need to see sales and profit.
        </EmptyState>
      ) : (
        <SectionBoundary
          isPending={summary.isPending || analytics.isPending}
          isError={summary.isError || analytics.isError}
          error={summary.error ?? analytics.error}
          refetch={() => {
            void summary.refetch();
            void analytics.refetch();
          }}
          label="Loading analytics"
          lines={6}
          height={72}
        >
          {summary.data && analytics.data && (
            <Body
              summary={summary.data}
              analytics={analytics.data}
              outstanding={outstanding}
              from={from}
              to={to}
            />
          )}
        </SectionBoundary>
      )}
    </PageStack>
  );
}
