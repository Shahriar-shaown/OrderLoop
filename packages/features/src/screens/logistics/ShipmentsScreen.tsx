import type { CourierEntry, ShipmentRow, ShipmentSummary } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  FilterMenu,
  Grid,
  Link,
  PageHeader,
  Pagination,
  Row,
  SearchField,
  Sheet,
  Split,
  Stack,
  StatCard,
  Tabs,
  Text,
  useBreakpoint,
  useTheme,
  type Column,
  useT,
} from '@orderloop/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CourierConnectionForm } from '../../components/logistics/CourierConnectionForm';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { ShipmentDetail } from '../../components/logistics/ShipmentDetail';
import { ShipmentStatusBadge } from '../../components/logistics/ShipmentStatusBadge';
import {
  COURIER_NAME,
  COURIER_STATE_LABEL,
  COURIER_STATE_TONE,
  courierState,
  ENVIRONMENT_LABEL,
  SHIPMENT_CHIPS,
  useCouriers,
} from '../../lib/couriers';
import { dayBefore, formatDayTime } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { formatPrice } from '../../lib/money';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';

const PAGE_SIZE = 25;
const DATE_RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];
const COD_ONLY = [{ value: 'true', label: 'On' }];

const sum = (counts: Record<string, number>, statuses: string[]) =>
  statuses.reduce((n, s) => n + (counts[s] ?? 0), 0);

/** One courier: its state and, from the shipments it has carried, how many, how many arrived and how long it took. */
function CourierCard({
  entry,
  stats,
  onManage,
  highlight,
}: {
  entry: CourierEntry;
  stats: ShipmentSummary['providers'][number] | undefined;
  onManage: () => void;
  highlight: boolean;
}) {
  const { colors } = useTheme();
  const t = useT();
  const state = courierState(entry);
  const env = entry.connection?.environment;
  const figure = (value: string, label: string) => (
    <Stack gap={1} grow style={{ minWidth: 80 }}>
      <Text variant="heading" numeric>
        {value}
      </Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </Stack>
  );
  return (
    <Card
      padding="md"
      role="group"
      aria-label={t(entry.name)}
      style={highlight ? { borderColor: colors.tones.warning.dot } : undefined}
    >
      <Stack gap={4}>
        <Row gap={2} wrap justify="between" align="start">
          <Stack gap={1} grow style={{ minWidth: 140 }}>
            <Text variant="title" role="heading" aria-level={2}>
              {entry.name}
            </Text>
            <Text variant="caption" tone="muted">
              {entry.simulated
                ? 'For practice: nothing leaves this system'
                : env
                  ? ENVIRONMENT_LABEL[env]
                  : 'Connect to book parcels and import settlements'}
            </Text>
          </Stack>
          <Row gap={2} wrap>
            {entry.simulated && <Badge tone="warning">SIMULATED</Badge>}
            <Badge tone={COURIER_STATE_TONE[state]} dot>
              {COURIER_STATE_LABEL[state]}
            </Badge>
          </Row>
        </Row>
        <Row gap={3}>
          {figure(stats ? String(stats.shipments) : '—', 'shipments')}
          {figure(
            stats?.deliveredRate != null ? `${(stats.deliveredRate * 100).toFixed(1)}%` : '—',
            'delivered',
          )}
          {figure(
            stats?.avgDeliveryDays != null ? `${stats.avgDeliveryDays.toFixed(1)} days` : '—',
            'avg time',
          )}
        </Row>
        <Row>
          <Button
            variant="secondary"
            size="sm"
            onPress={onManage}
            accessibilityLabel={`${state === 'not_connected' ? 'Connect' : 'Manage'} ${entry.name}`}
          >
            {state === 'not_connected' ? 'Connect' : 'Manage'}
          </Button>
        </Row>
      </Stack>
    </Card>
  );
}

/** Couriers & shipments: the courier connections, the day's numbers, and every parcel with its history. */
export function ShipmentsScreen() {
  const t = useT();
  const api = useApi();
  const can = useCan();
  const { isDesktop } = useBreakpoint();
  const [chip, setChip] = useState('all');
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState('');
  const [range, setRange] = useState('');
  const [codOnly, setCodOnly] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const q = useDebounced(search.trim());

  const couriers = useCouriers();
  const stats = useQuery({
    queryKey: ['shipments', 'stats'],
    queryFn: () => api.shipments.stats(),
  });
  const statuses = SHIPMENT_CHIPS.find((c) => c.value === chip)?.statuses ?? [];
  const filters = {
    ...(q ? { q } : {}),
    ...(statuses.length ? { status: statuses.join(',') } : {}),
    ...(provider ? { provider } : {}),
    ...(codOnly ? { codOnly: 'true' } : {}),
    ...(range ? { from: dayBefore(Number(range)) } : {}),
  };
  const list = useQuery({
    queryKey: ['shipments', 'list', filters, page],
    queryFn: () => api.shipments.list({ ...filters, page, limit: PAGE_SIZE } as never),
    placeholderData: keepPreviousData,
  });
  const change = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const entries = couriers.data ?? [];
  const byProvider = new Map((stats.data?.providers ?? []).map((p) => [p.provider, p]));
  const needsAttention = entries.filter((c) => courierState(c) === 'attention');
  const managed = entries.find((c) => c.provider === managing);
  const counts = list.data?.statusCounts ?? {};
  const allCount = sum(counts, Object.keys(counts));
  const totalShipments = stats.data?.providers.reduce((n, p) => n + p.shipments, 0);
  const s = stats.data;
  const filtered = Object.keys(filters).length > 0;

  const columns: Column<ShipmentRow>[] = [
    {
      key: 'shipment',
      header: 'Shipment',
      flex: 2,
      minWidth: 190,
      render: (r) => (
        <Stack gap={1}>
          <Link href={`/orders/${r.orderId}`} weight="medium">
            {r.consignmentId ?? r.reference}
          </Link>
          <Text variant="caption" tone="muted">{`#${r.orderNumber} · ${r.customerName}`}</Text>
        </Stack>
      ),
    },
    {
      key: 'courier',
      header: 'Courier',
      minWidth: 120,
      show: 'wide',
      render: (r) => (
        <Stack gap={1}>
          <Text>{COURIER_NAME[r.provider]}</Text>
          {r.simulated && <Badge tone="warning">SIMULATED</Badge>}
        </Stack>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      flex: 2,
      minWidth: 170,
      render: (r) => <ShipmentStatusBadge status={r.status} />,
    },
    {
      key: 'cod',
      header: 'COD',
      align: 'right',
      minWidth: 100,
      render: (r) => <Text numeric>{formatPrice(r.codAmountMinor)}</Text>,
    },
    {
      key: 'fee',
      header: 'Fee',
      align: 'right',
      minWidth: 90,
      show: 'desktop',
      render: (r) => (
        <Text numeric>{r.deliveryFeeMinor !== null ? formatPrice(r.deliveryFeeMinor) : '—'}</Text>
      ),
    },
    {
      key: 'updated',
      header: 'Updated',
      minWidth: 120,
      show: 'wide',
      render: (r) => formatDayTime(r.updatedAt),
    },
  ];

  const card = (r: ShipmentRow) => (
    <Stack gap={2}>
      <Row justify="between" gap={2} align="start">
        <Stack gap={1} grow>
          <Text weight="medium">{r.consignmentId ?? r.reference}</Text>
          <Text variant="caption" tone="muted">{`#${r.orderNumber} · ${r.customerName}`}</Text>
        </Stack>
        <ShipmentStatusBadge status={r.status} />
      </Row>
      <Row justify="between" gap={2} wrap>
        <Text variant="small" tone="muted">
          {`${COURIER_NAME[r.provider]}${r.simulated ? ' (simulated)' : ''} · ${formatDayTime(r.updatedAt)}`}
        </Text>
        <Text numeric weight="medium">
          {formatPrice(r.codAmountMinor)}
        </Text>
      </Row>
    </Stack>
  );

  const table = (
    <QueryBoundary
      isPending={list.isPending}
      isError={list.isError}
      error={list.error}
      data={list.data}
      fetchStatus={list.fetchStatus}
      refetch={() => list.refetch()}
      label="Loading shipments"
    >
      <DataTable
        label="Shipments"
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(r) => r.id}
        onRowPress={(r) => setSelected(r.id)}
        rowLabel={(r) => `Shipment ${r.consignmentId ?? r.reference}`}
        renderCard={card}
        loading={list.isFetching && !list.data}
        empty={
          <EmptyState icon="truck" title={filtered ? 'No shipments match' : 'No shipments yet'}>
            {filtered
              ? 'Try a different search or filter.'
              : 'Book a courier from an order that is ready to ship and it will appear here.'}
          </EmptyState>
        }
        footer={
          list.data && list.data.total > 0 ? (
            <Pagination
              summary={`Showing ${(list.data.page - 1) * PAGE_SIZE + 1}–${Math.min(list.data.page * PAGE_SIZE, list.data.total)} of ${list.data.total} shipments`}
              page={list.data.page}
              pages={list.data.pages}
              onPage={setPage}
            />
          ) : undefined
        }
      />
    </QueryBoundary>
  );

  const detail = selected ? (
    isDesktop ? (
      <Card padding="md" role="complementary" aria-label={t('Shipment detail')}>
        <Stack gap={3}>
          <Row justify="end">
            <Button
              variant="ghost"
              size="sm"
              icon="x"
              accessibilityLabel="Close shipment detail"
              onPress={() => setSelected(null)}
            />
          </Row>
          <ShipmentDetail id={selected} />
        </Stack>
      </Card>
    ) : (
      <Sheet open onClose={() => setSelected(null)} title="Shipment">
        <ShipmentDetail id={selected} />
      </Sheet>
    )
  ) : null;

  return (
    <Stack gap={5}>
      <PageHeader
        title="Couriers & shipments"
        description={
          totalShipments !== undefined && stats.data
            ? `${totalShipments} shipments · ${entries.length} courier integrations`
            : undefined
        }
      />

      {needsAttention.map((c) => (
        <Alert
          key={c.provider}
          tone="warning"
          title={`${c.name} needs attention`}
          action={
            can('couriers:manage') ? (
              <Button variant="secondary" size="sm" onPress={() => setManaging(c.provider)}>
                Manage
              </Button>
            ) : undefined
          }
        >
          {c.connection?.lastCheckMessage ?? 'The last connection check failed.'}
        </Alert>
      ))}

      <QueryBoundary {...couriers} refetch={() => couriers.refetch()} label="Loading couriers">
        <Grid columns={{ mobile: 1, tablet: 2, desktop: 3 }}>
          {entries.map((c) => (
            <CourierCard
              key={c.provider}
              entry={c}
              stats={byProvider.get(c.provider)}
              highlight={courierState(c) === 'attention'}
              onManage={() => setManaging(c.provider)}
            />
          ))}
        </Grid>
      </QueryBoundary>

      {stats.isError ? (
        <Alert
          tone="error"
          action={
            <Button variant="secondary" size="sm" onPress={() => stats.refetch()}>
              Try again
            </Button>
          }
        >
          The shipment figures could not be loaded.
        </Alert>
      ) : (
        <Grid columns={{ mobile: 2, tablet: 3, desktop: 6 }}>
          <StatCard icon="truck" label="Booked today" value={s ? String(s.bookedToday) : '—'} />
          <StatCard
            icon="clock"
            label="Awaiting pickup"
            value={s ? String(s.awaitingPickup) : '—'}
          />
          <StatCard
            icon="box"
            label="On the way"
            value={s ? String(s.onTheWay) : '—'}
            hint={s ? `${s.delayed} delayed` : undefined}
            tone={s && s.delayed > 0 ? 'warning' : 'default'}
          />
          <StatCard
            icon="check-circle"
            label={`Delivered (${s?.recentDays ?? 7}d)`}
            value={s ? String(s.delivered) : '—'}
          />
          <StatCard
            icon="return"
            label={`Returned (${s?.recentDays ?? 7}d)`}
            value={s ? String(s.returned) : '—'}
          />
          <StatCard
            icon="wallet"
            label="COD on the way"
            value={s ? formatPrice(s.codOnTheWayMinor) : '—'}
            hint={s ? `${s.codOnTheWayCount} shipments` : undefined}
          />
        </Grid>
      )}

      <Tabs
        variant="chips"
        label="Shipment status"
        value={chip}
        onChange={(v) => change(() => setChip(v))}
        items={SHIPMENT_CHIPS.map((c) => ({
          value: c.value,
          label: c.label,
          count: list.data ? (c.value === 'all' ? allCount : sum(counts, c.statuses)) : undefined,
        }))}
      />

      <Row gap={3} wrap align="center">
        <Stack grow style={{ minWidth: 240, maxWidth: 420 }}>
          <SearchField
            label="Search shipments"
            placeholder="Tracking ID, order number or customer"
            value={search}
            onChangeText={(t) => change(() => setSearch(t))}
          />
        </Stack>
        <FilterMenu
          label="Courier"
          value={provider}
          onChange={(v) => change(() => setProvider(v))}
          options={entries.map((c) => ({ value: c.provider, label: c.name }))}
        />
        <FilterMenu
          label="Date"
          value={range}
          onChange={(v) => change(() => setRange(v))}
          options={DATE_RANGES}
          allLabel="All time"
        />
        <FilterMenu
          label="COD only"
          value={codOnly}
          onChange={(v) => change(() => setCodOnly(v))}
          options={COD_ONLY}
          allLabel="Off"
        />
      </Row>

      {selected && isDesktop ? (
        <Split main={table} aside={detail} asideWidth={420} sticky />
      ) : (
        <>
          {table}
          {detail}
        </>
      )}

      <Sheet
        open={!!managed}
        onClose={() => setManaging(null)}
        title={managed ? `${managed.name} connection` : 'Courier'}
      >
        {managed && <CourierConnectionForm entry={managed} canManage={can('couriers:manage')} />}
      </Sheet>
    </Stack>
  );
}
