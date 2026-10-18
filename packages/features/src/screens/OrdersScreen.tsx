import type { OrderQuery, OrderStatus, OrderSummary } from '@orderloop/contracts';
import {
  Alert,
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  FieldGrid,
  Link,
  LoadMore,
  PageHeader,
  Row,
  SelectField,
  Stack,
  Text,
  TextField,
  useToast,
  type Column,
} from '@orderloop/ui';
import { formatBdPhone } from '@orderloop/domain';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { OrderStatusBadge } from '../components/OrderStatusBadge';
import { QueryBoundary } from '../components/QueryBoundary';
import { ReasonDialog } from '../components/ReasonDialog';
import { messageFor } from '../errors';
import { formatWhen } from '../format';
import { useDebounced } from '../hooks';
import { formatPrice } from '../money';
import {
  invalidateOrders,
  SOURCE_LABEL,
  SOURCE_OPTIONS,
  STATUS_LABEL,
  STATUS_OPTIONS,
} from '../orders';
import { useCan } from '../permissions';
import { useApi } from '../runtime';
import { saveTextFile } from '../saveFile';

const SORTS: { value: string; label: string; sort: OrderQuery['sort']; dir: OrderQuery['dir'] }[] =
  [
    { value: 'new', label: 'Newest first', sort: 'createdAt', dir: 'desc' },
    { value: 'old', label: 'Oldest first', sort: 'createdAt', dir: 'asc' },
    { value: 'high', label: 'Highest total', sort: 'totalMinor', dir: 'desc' },
    { value: 'low', label: 'Lowest total', sort: 'totalMinor', dir: 'asc' },
    { value: 'number', label: 'Order number', sort: 'orderNumber', dir: 'desc' },
    { value: 'status', label: 'Status', sort: 'status', dir: 'asc' },
  ];
const ALL = { value: '', label: 'All' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** What the bulk bar offers. Each is the same status change the order page offers, applied to every selected order. */
const BULK: { status: OrderStatus; label: string; reason?: boolean }[] = [
  { status: 'confirmed', label: 'Confirm' },
  { status: 'ready_to_ship', label: 'Ready to ship' },
  { status: 'shipped', label: 'Mark shipped' },
  { status: 'cancelled', label: 'Cancel…', reason: true },
];

export function OrdersScreen() {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sortKey, setSortKey] = useState('new');
  const q = useDebounced(search.trim());
  const sort = SORTS.find((s) => s.value === sortKey)!;

  // The list endpoint takes statuses and sources as comma-separated text (`confirmed,ready_to_ship`).
  const filters = useMemo(
    () => ({
      ...(q ? { q } : {}),
      ...(status ? { status } : {}),
      ...(source ? { source } : {}),
      ...(DATE_RE.test(from) ? { from } : {}),
      ...(DATE_RE.test(to) ? { to } : {}),
    }),
    [q, status, source, from, to],
  );

  const orders = useInfiniteQuery({
    queryKey: ['orders', filters, sortKey],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.orders.list({
        ...(filters as object),
        sort: sort.sort,
        dir: sort.dir,
        limit: 25,
        ...(pageParam ? { cursor: pageParam } : {}),
      } as never),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = orders.data?.pages.flatMap((p) => p.items) ?? [];
  const total = orders.data?.pages[0]?.total ?? 0;
  const filtered = Object.keys(filters).length > 0;

  // ---- selection and bulk actions ------------------------------------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [bulkIssues, setBulkIssues] = useState<string[]>([]);
  // A different list means a different selection: never act on rows the person can no longer see.
  useEffect(() => setSelected(new Set()), [filters, sortKey]);
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allShown = rows.length > 0 && rows.every((r) => selected.has(r.id));

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
      setSelected(new Set(result.results.filter((r) => !r.ok).map((r) => r.orderId)));
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBulkBusy(false);
    }
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

  const columns: Column<OrderSummary>[] = [
    ...(can('orders:write')
      ? [
          {
            key: 'select',
            header: 'Select',
            minWidth: 70,
            flex: 0,
            render: (o: OrderSummary) => (
              <Checkbox
                label={`Select order ${o.orderNumber}`}
                hideLabel
                checked={selected.has(o.id)}
                onChange={(on) => toggle(o.id, on)}
              />
            ),
          },
        ]
      : []),
    {
      key: 'number',
      header: 'Order',
      minWidth: 110,
      render: (o) => (
        <Link href={`/orders/${o.id}`} weight="medium">
          {`#${o.orderNumber}`}
        </Link>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      flex: 3,
      minWidth: 200,
      render: (o) => (
        <Stack gap={1}>
          <Text weight="medium">{o.customerName}</Text>
          <Text variant="caption" tone="muted">
            {formatBdPhone(o.phone)} · {o.district}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      minWidth: 170,
      flex: 2,
      render: (o) => <OrderStatusBadge status={o.status} />,
    },
    { key: 'source', header: 'Source', minWidth: 110, render: (o) => SOURCE_LABEL[o.source] },
    {
      key: 'items',
      header: 'Items',
      align: 'right',
      minWidth: 70,
      render: (o) => String(o.itemCount),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      minWidth: 120,
      render: (o) => formatPrice(o.totalMinor),
    },
    {
      key: 'cod',
      header: 'COD',
      align: 'right',
      minWidth: 120,
      render: (o) => formatPrice(o.codAmountMinor),
    },
    {
      key: 'when',
      header: 'Created',
      flex: 2,
      minWidth: 160,
      render: (o) => formatWhen(o.createdAt),
    },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Orders"
        description="Every order, from the chat to the doorstep."
        actions={
          <Row gap={2} wrap>
            <Button variant="secondary" onPress={exportCsv}>
              Export CSV
            </Button>
            {can('orders:write') && (
              <Button variant="secondary" href="/orders/import">
                Import
              </Button>
            )}
            {can('orders:write') && <Button href="/orders/new">New order</Button>}
          </Row>
        }
      />
      <FieldGrid minWidth={170}>
        <TextField
          label="Search"
          kind="search"
          placeholder="Number, name, phone, SKU"
          value={search}
          onChangeText={setSearch}
        />
        <SelectField
          label="Status"
          options={[ALL, ...STATUS_OPTIONS]}
          value={status}
          onChange={setStatus}
        />
        <SelectField
          label="Source"
          options={[ALL, ...SOURCE_OPTIONS]}
          value={source}
          onChange={setSource}
        />
        <SelectField label="Sort by" options={SORTS} value={sortKey} onChange={setSortKey} />
        <TextField
          label="From date"
          placeholder="2026-10-01"
          autoCapitalize="none"
          value={from}
          onChangeText={setFrom}
          error={from && !DATE_RE.test(from) ? 'Use YYYY-MM-DD' : undefined}
        />
        <TextField
          label="To date"
          placeholder="2026-10-31"
          autoCapitalize="none"
          value={to}
          onChangeText={setTo}
          error={to && !DATE_RE.test(to) ? 'Use YYYY-MM-DD' : undefined}
        />
      </FieldGrid>

      {selected.size > 0 && (
        <Stack gap={2}>
          <Row gap={2} wrap>
            <Text weight="bold">{`${selected.size} selected`}</Text>
            {BULK.map((b) => (
              <Button
                key={b.status}
                size="sm"
                variant={b.status === 'cancelled' ? 'danger' : 'secondary'}
                loading={bulkBusy}
                onPress={() => (b.reason ? setCancelling(true) : bulk(b.status))}
              >
                {b.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onPress={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </Row>
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

      <QueryBoundary {...orders} refetch={() => orders.refetch()} label="Loading orders">
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? 'No orders match' : 'No orders yet'}
            action={
              !filtered && can('orders:write') ? (
                <Button href="/orders/new">Create your first order</Button>
              ) : undefined
            }
          >
            {filtered
              ? 'Try a different search or filter.'
              : 'Orders from Facebook, Instagram, WhatsApp and calls all live here.'}
          </EmptyState>
        ) : (
          <Stack gap={3}>
            <Row gap={3} wrap>
              <Text tone="muted">{`${total} order${total === 1 ? '' : 's'}${filtered ? ' match' : ''}`}</Text>
              {can('orders:write') && (
                <Checkbox
                  label="Select all shown"
                  checked={allShown}
                  onChange={(on) => setSelected(on ? new Set(rows.map((r) => r.id)) : new Set())}
                />
              )}
            </Row>
            <DataTable label="Orders" columns={columns} rows={rows} rowKey={(o) => o.id} />
            <LoadMore
              hasNext={!!orders.hasNextPage}
              loading={orders.isFetchingNextPage}
              onPress={() => orders.fetchNextPage()}
            />
          </Stack>
        )}
      </QueryBoundary>
      <ReasonDialog
        open={cancelling}
        title={`Cancel ${selected.size} order${selected.size === 1 ? '' : 's'}`}
        submitLabel="Cancel orders"
        onSubmit={(reason) => bulk('cancelled', reason)}
        onClose={() => setCancelling(false)}
      />
    </Stack>
  );
}
