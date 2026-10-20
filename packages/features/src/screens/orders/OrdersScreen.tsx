import {
  ORDER_STATUS_VALUES,
  type OrderQuery,
  type OrderStatus,
  type OrderSummary,
} from '@orderloop/contracts';
import { canTransition, editScope } from '@orderloop/domain';
import {
  Alert,
  Button,
  Card,
  DataTable,
  DateRangeFilter,
  EmptyState,
  FilterMenu,
  Menu,
  PageHeader,
  Pagination,
  Row,
  SearchField,
  Stack,
  Tabs,
  Text,
  useNavigation,
  useToast,
  type Column,
  type MenuItem,
  isRealDay,
  useT,
} from '@orderloop/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { OrderCard, orderColumns, selectOrderLabel } from '../../components/orders/OrderListParts';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { ReasonDialog } from '../../forms/ReasonDialog';
import { messageFor } from '../../forms/errors';
import { dayBefore, formatShortDay } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { invalidateOrders, SOURCE_OPTIONS, STATUS_LABEL } from '../../lib/orders';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { saveTextFile } from '../../lib/saveFile';

const PAGE_SIZE = 25;

/** Sorting. The first is the default and is what the chip's "all" option stands for. */
const SORTS: { value: string; label: string; sort: OrderQuery['sort']; dir: OrderQuery['dir'] }[] =
  [
    { value: 'new', label: 'Newest first', sort: 'createdAt', dir: 'desc' },
    { value: 'old', label: 'Oldest first', sort: 'createdAt', dir: 'asc' },
    { value: 'high', label: 'Highest total', sort: 'totalMinor', dir: 'desc' },
    { value: 'low', label: 'Lowest total', sort: 'totalMinor', dir: 'asc' },
    { value: 'number', label: 'Order number', sort: 'orderNumber', dir: 'desc' },
    { value: 'status', label: 'Status', sort: 'status', dir: 'asc' },
  ];

/** What the bulk bar offers. Each is the same status change the order page offers, applied to every selected order. */
const BULK: { status: OrderStatus; label: string; reason?: boolean }[] = [
  { status: 'confirmed', label: 'Confirm' },
  { status: 'ready_to_ship', label: 'Ready to ship' },
  { status: 'shipped', label: 'Mark shipped' },
  { status: 'cancelled', label: 'Cancel…', reason: true },
];

const DATE_PRESETS = () => [
  { label: 'Today', from: dayBefore(0), to: dayBefore(0) },
  { label: 'Last 7 days', from: dayBefore(6), to: dayBefore(0) },
  { label: 'Last 30 days', from: dayBefore(29), to: dayBefore(0) },
];

export function OrdersScreen({
  initialStatus,
  initialFrom,
  initialTo,
}: {
  initialStatus?: string | undefined;
  initialFrom?: string | undefined;
  initialTo?: string | undefined;
} = {}) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const t = useT();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(
    (ORDER_STATUS_VALUES as readonly string[]).includes(initialStatus ?? '')
      ? (initialStatus as string)
      : '',
  );
  const [source, setSource] = useState('');
  const [from, setFrom] = useState(initialFrom && isRealDay(initialFrom) ? initialFrom : '');
  const [to, setTo] = useState(initialTo && isRealDay(initialTo) ? initialTo : '');
  // '' is the default sort (the filter chip's "all").
  const [sortKey, setSortKey] = useState('');
  const q = useDebounced(search.trim());
  const sort = SORTS.find((s) => s.value === (sortKey || 'new'))!;

  // The list endpoint takes statuses and sources as comma-separated text (`confirmed,ready_to_ship`).
  const filters = useMemo(
    () => ({
      ...(q ? { q } : {}),
      ...(status ? { status } : {}),
      ...(source ? { source } : {}),
      ...(isRealDay(from) ? { from } : {}),
      ...(isRealDay(to) ? { to } : {}),
    }),
    [q, status, source, from, to],
  );
  const filtered = Object.keys(filters).length > 0;

  // The API reads by cursor, so Previous needs the cursors already passed: a stack with the first page (no cursor) at the bottom.
  // The stack belongs to one set of filters: read under any other it is the first page, so a stale cursor is never sent with new filters.
  const filterKey = JSON.stringify([filters, sortKey]);
  const [paging, setPaging] = useState<{ key: string; stack: (string | undefined)[] }>({
    key: filterKey,
    stack: [undefined],
  });
  const cursors = paging.key === filterKey ? paging.stack : [undefined];
  const cursor = cursors[cursors.length - 1];
  const setCursors = (next: (stack: (string | undefined)[]) => (string | undefined)[]) =>
    setPaging({ key: filterKey, stack: next(cursors) });

  const orders = useQuery({
    queryKey: ['orders', filters, sortKey, cursor ?? null],
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.orders.list({
        ...(filters as object),
        sort: sort.sort,
        dir: sort.dir,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      } as never),
  });
  const page = orders.data;
  const rows = page?.items ?? [];
  const total = page?.total ?? 0;
  const counts = page?.statusCounts;
  const firstShown = (cursors.length - 1) * PAGE_SIZE + 1;

  // ---- selection and bulk actions ------------------------------------------------------------------------------------
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [cancelling, setCancelling] = useState<'bulk' | OrderSummary | null>(null);
  const [bulkIssues, setBulkIssues] = useState<string[]>([]);
  // A different list means a different selection: never act on rows the person can no longer see.
  useEffect(() => setSelected([]), [filters, sortKey, cursor]);

  async function bulk(target: OrderStatus, reason?: string) {
    setBulkBusy(true);
    setBulkIssues([]);
    try {
      const result = await api.orders.bulkChangeStatus({
        orderIds: [...selected],
        status: target,
        ...(reason ? { reason } : {}),
      });
      await invalidateOrders(queryClient);
      if (result.failed === 0)
        toast.success(
          `${result.succeeded} order${result.succeeded === 1 ? '' : 's'}: ${STATUS_LABEL[target].toLowerCase()}`,
        );
      else
        setBulkIssues(
          result.results
            .filter((r) => !r.ok)
            .map((r) => `#${r.orderNumber ?? '?'}: ${r.error?.message ?? 'could not be updated'}`),
        );
      if (result.succeeded > 0 && result.failed > 0)
        toast.info(`${result.succeeded} updated, ${result.failed} could not be`);
      setSelected(result.results.filter((r) => !r.ok).map((r) => r.orderId));
    } finally {
      setBulkBusy(false);
    }
  }
  // Errors reach the caller: the reason dialog shows them and stays open, the plain buttons toast them.
  const bulkWithToast = (target: OrderStatus) =>
    bulk(target).catch((error: unknown) => toast.error(messageFor(error)));

  async function cancelOne(order: OrderSummary, reason: string) {
    await api.orders.changeStatus(order.id, { status: 'cancelled', reason });
    await invalidateOrders(queryClient);
    toast.success(`Order #${order.orderNumber}: cancelled`);
  }

  async function exportCsv() {
    try {
      const file = await api.exports.orders(filters as never);
      await saveTextFile(file.filename, file.csv);
      toast.success(`${file.filename}: ${file.rowCount} rows`);
    } catch (error) {
      toast.error(messageFor(error));
    }
  }

  function clearFilters() {
    setSearch('');
    setStatus('');
    setSource('');
    setFrom('');
    setTo('');
  }

  const write = can('orders:write');
  const rowMenu = (o: OrderSummary): MenuItem[] => [
    { key: 'view', label: 'View details', icon: 'file', href: `/orders/${o.id}` },
    ...(write && editScope(o.status) !== 'none'
      ? [{ key: 'edit', label: 'Edit', icon: 'edit' as const, href: `/orders/${o.id}/edit` }]
      : []),
    ...(write && canTransition(o.status, 'cancelled')
      ? [
          {
            key: 'cancel',
            label: 'Cancel…',
            icon: 'x' as const,
            danger: true,
            onPress: () => setCancelling(o),
          },
        ]
      : []),
  ];

  const columns: Column<OrderSummary>[] = [
    ...orderColumns(),
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      flex: 0,
      minWidth: 84,
      render: (o) => <Menu label={`Actions for order ${o.orderNumber}`} items={rowMenu(o)} />,
    },
  ];

  const chips = [
    {
      value: '',
      label: 'All',
      count: counts ? Object.values(counts).reduce((a, b) => a + b, 0) : undefined,
    },
    ...ORDER_STATUS_VALUES.map((s) => ({
      value: s,
      label: STATUS_LABEL[s],
      count: counts ? (counts[s] ?? 0) : undefined,
    })),
  ];

  const empty = (
    <EmptyState
      icon="box"
      title={filtered ? 'No orders match' : 'No orders yet'}
      action={
        filtered ? (
          <Button variant="secondary" onPress={clearFilters}>
            Clear filters
          </Button>
        ) : write ? (
          <Button href="/orders/new">Create your first order</Button>
        ) : undefined
      }
    >
      {filtered
        ? 'Try a different search or filter.'
        : 'Orders from Facebook, Instagram, WhatsApp and calls all live here.'}
    </EmptyState>
  );

  return (
    <Stack gap={5}>
      <PageHeader
        title="Orders"
        description={`${total} order${total === 1 ? '' : 's'} · ${selected.length} selected`}
        actions={
          <>
            {write && (
              <Button variant="secondary" icon="upload" href="/orders/import">
                Import
              </Button>
            )}
            <Button variant="secondary" icon="download" onPress={exportCsv}>
              Export
            </Button>
            {write && (
              <Button icon="plus" href="/orders/new">
                Create order
              </Button>
            )}
          </>
        }
      />

      <Tabs
        variant="chips"
        label="Order status"
        items={chips}
        value={status}
        onChange={setStatus}
      />

      <Row gap={2} wrap>
        <Stack grow style={{ minWidth: 240 }}>
          <SearchField
            label="Search"
            placeholder="Order number, name, phone or SKU"
            value={search}
            onChangeText={setSearch}
          />
        </Stack>
        <FilterMenu label="Source" value={source} options={SOURCE_OPTIONS} onChange={setSource} />
        <DateRangeFilter
          from={from}
          to={to}
          presets={DATE_PRESETS()}
          format={formatShortDay}
          onChange={(f, t) => {
            setFrom(f);
            setTo(t);
          }}
        />
        <FilterMenu
          label="Sort"
          allLabel={SORTS[0]!.label}
          value={sortKey}
          options={SORTS.slice(1).map((s) => ({ value: s.value, label: s.label }))}
          onChange={setSortKey}
        />
      </Row>

      {selected.length > 0 && (
        <Stack gap={2}>
          <Card variant="filled" padding="sm" role="toolbar" aria-label={t('Selected orders')}>
            <Row gap={2} wrap justify="between">
              <Text
                variant="label"
                tone="primary"
              >{`${selected.length} order${selected.length === 1 ? '' : 's'} selected`}</Text>
              <Row gap={1} wrap>
                {BULK.map((b) => (
                  <Button
                    key={b.status}
                    size="sm"
                    variant={b.status === 'cancelled' ? 'danger' : 'tertiary'}
                    loading={bulkBusy}
                    onPress={() => (b.reason ? setCancelling('bulk') : bulkWithToast(b.status))}
                  >
                    {b.label}
                  </Button>
                ))}
                <Button size="sm" variant="tertiary" onPress={exportCsv}>
                  Export CSV
                </Button>
                <Button size="sm" variant="ghost" onPress={() => setSelected([])}>
                  Clear
                </Button>
              </Row>
            </Row>
          </Card>
          {bulkIssues.length > 0 && (
            <Alert tone="warning" title="Some orders could not be updated">
              <Stack gap={1}>
                {bulkIssues.slice(0, 10).map((m) => (
                  <Text key={m}>{m}</Text>
                ))}
              </Stack>
            </Alert>
          )}
        </Stack>
      )}

      {orders.isError ? (
        <QueryBoundary
          isPending={false}
          isError
          error={orders.error}
          refetch={() => orders.refetch()}
        >
          {null}
        </QueryBoundary>
      ) : (
        <DataTable
          label="Orders"
          columns={columns}
          rows={rows}
          rowKey={(o) => o.id}
          loading={orders.isPending}
          empty={empty}
          onRowPress={(o) => navigation.push(`/orders/${o.id}`)}
          rowLabel={(o) => `Order #${o.orderNumber}`}
          renderCard={(o) => <OrderCard order={o} />}
          {...(write
            ? { selection: { selected, onChange: setSelected }, selectLabel: selectOrderLabel }
            : {})}
          footer={
            rows.length > 0 ? (
              <Pagination
                summary={`Showing ${firstShown}–${firstShown + rows.length - 1} of ${total} order${total === 1 ? '' : 's'}`}
                hasPrevious={cursors.length > 1}
                hasNext={!!page?.nextCursor}
                onPrevious={() => setCursors((c) => c.slice(0, -1))}
                onNext={() => page?.nextCursor && setCursors((c) => [...c, page.nextCursor!])}
              />
            ) : undefined
          }
        />
      )}

      <ReasonDialog
        open={cancelling !== null}
        title={
          cancelling && cancelling !== 'bulk'
            ? `Cancel order #${cancelling.orderNumber}`
            : `Cancel ${selected.length} order${selected.length === 1 ? '' : 's'}`
        }
        submitLabel={cancelling && cancelling !== 'bulk' ? 'Cancel order' : 'Cancel orders'}
        onSubmit={(reason) =>
          cancelling && cancelling !== 'bulk'
            ? cancelOne(cancelling, reason)
            : bulk('cancelled', reason)
        }
        onClose={() => setCancelling(null)}
      />
    </Stack>
  );
}
