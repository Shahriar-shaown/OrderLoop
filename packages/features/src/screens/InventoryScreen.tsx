import type { LowStockItem, Movement, Reservation, StockLine } from '@orderloop/contracts';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  FieldGrid,
  LoadMore,
  PageHeader,
  Row,
  SelectField,
  Stack,
  Tabs,
  Text,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ExportButtons } from '../components/ExportButtons';
import { QueryBoundary } from '../components/QueryBoundary';
import {
  invalidateStock,
  StockDialog,
  type StockMode,
  type VariantRef,
} from '../components/StockDialog';
import { messageFor } from '../errors';
import { formatWhen, variantLabel } from '../format';
import { useLocations } from '../hooks';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

type Tab = 'levels' | 'low' | 'movements' | 'reservations';
type Request = { mode: StockMode; variant: VariantRef; locationId?: string } | null;

const TABS = [
  { value: 'levels', label: 'Stock levels' },
  { value: 'low', label: 'Low stock' },
  { value: 'movements', label: 'Movements' },
  { value: 'reservations', label: 'Reservations' },
];

const MOVEMENT_TONE = {
  RECEIVE: 'success',
  ADJUSTMENT: 'info',
  RESERVE: 'warning',
  RELEASE: 'neutral',
  SHIP: 'neutral',
  DAMAGE: 'error',
  WRITE_OFF: 'neutral',
  RETURN: 'success',
} as const;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function StockActions({
  canWrite,
  onPick,
  receiveOnly = false,
  hasDamaged = false,
}: {
  canWrite: boolean;
  onPick: (mode: StockMode) => void;
  receiveOnly?: boolean;
  hasDamaged?: boolean;
}) {
  if (!canWrite) return null;
  return (
    <Row gap={1} wrap>
      <Button size="sm" variant="secondary" onPress={() => onPick('receive')}>
        Receive
      </Button>
      {!receiveOnly && (
        <Button size="sm" variant="secondary" onPress={() => onPick('adjust')}>
          Adjust
        </Button>
      )}
      {!receiveOnly && (
        <Button size="sm" variant="secondary" onPress={() => onPick('reserve')}>
          Reserve
        </Button>
      )}
      {!receiveOnly && (
        <Button size="sm" variant="secondary" onPress={() => onPick('damage')}>
          Damaged
        </Button>
      )}
      {!receiveOnly && hasDamaged && (
        <Button size="sm" variant="secondary" onPress={() => onPick('writeOff')}>
          Write off
        </Button>
      )}
      {!receiveOnly && (
        <Button size="sm" variant="secondary" onPress={() => onPick('return')}>
          Return
        </Button>
      )}
    </Row>
  );
}

function Levels({ ask }: { ask: (r: NonNullable<Request>) => void }) {
  const api = useApi();
  const can = useCan();
  const locations = useLocations();
  const [locationId, setLocationId] = useState('');
  const options = useMemo(
    () => [
      { value: '', label: 'All locations' },
      ...(locations.data ?? []).map((l) => ({ value: l.id, label: l.name })),
    ],
    [locations.data],
  );
  const query = useInfiniteQuery({
    queryKey: ['inventory', { locationId }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.inventory.list({
        limit: 50,
        ...(locationId ? { locationId } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const columns: Column<StockLine>[] = [
    {
      key: 'item',
      header: 'Item',
      flex: 3,
      minWidth: 220,
      render: (r) => (
        <Stack gap={1}>
          <Text weight="medium">{variantLabel(r.productName, r.variantName)}</Text>
          <Text variant="caption" tone="muted">
            {r.sku}
          </Text>
        </Stack>
      ),
    },
    { key: 'location', header: 'Location', flex: 2, render: (r) => r.locationName },
    {
      key: 'onHand',
      header: 'On hand',
      align: 'right',
      minWidth: 90,
      render: (r) => String(r.onHand),
    },
    {
      key: 'reserved',
      header: 'Reserved',
      align: 'right',
      minWidth: 90,
      render: (r) => String(r.reserved),
    },
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      minWidth: 100,
      render: (r) =>
        r.reorderPoint > 0 && r.available <= r.reorderPoint ? (
          <Badge tone="warning">{`${r.available} low`}</Badge>
        ) : (
          String(r.available)
        ),
    },
    {
      key: 'damaged',
      header: 'Damaged',
      align: 'right',
      minWidth: 90,
      render: (r) => String(r.damaged),
    },
    {
      key: 'actions',
      header: 'Actions',
      flex: 2,
      minWidth: 420,
      render: (r) => (
        <StockActions
          canWrite={can('inventory:write')}
          hasDamaged={r.damaged > 0}
          onPick={(mode) =>
            ask({
              mode,
              variant: {
                id: r.variantId,
                sku: r.sku,
                label: variantLabel(r.productName, r.variantName),
              },
              locationId: r.locationId,
            })
          }
        />
      ),
    },
  ];
  return (
    <Stack gap={4}>
      <FieldGrid minWidth={240}>
        <SelectField
          label="Location"
          options={options}
          value={locationId}
          onChange={setLocationId}
        />
      </FieldGrid>
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading stock">
        {rows.length === 0 ? (
          <EmptyState title="No stock recorded yet">
            Receive stock on a product's page to start counting it.
          </EmptyState>
        ) : (
          <>
            <DataTable
              label="Stock levels"
              columns={columns}
              rows={rows}
              rowKey={(r) => `${r.variantId}:${r.locationId}`}
            />
            <LoadMore
              hasNext={!!query.hasNextPage}
              loading={query.isFetchingNextPage}
              onPress={() => query.fetchNextPage()}
            />
          </>
        )}
      </QueryBoundary>
    </Stack>
  );
}

function Low({ ask }: { ask: (r: NonNullable<Request>) => void }) {
  const api = useApi();
  const can = useCan();
  const query = useQuery({ queryKey: ['lowStock'], queryFn: () => api.inventory.lowStock() });
  const columns: Column<LowStockItem>[] = [
    {
      key: 'item',
      header: 'Item',
      flex: 3,
      minWidth: 220,
      render: (r) => (
        <Stack gap={1}>
          <Text weight="medium">{variantLabel(r.productName, r.variantName)}</Text>
          <Text variant="caption" tone="muted">
            {r.sku}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      minWidth: 100,
      render: (r) => String(r.available),
    },
    {
      key: 'reorder',
      header: 'Reorder at',
      align: 'right',
      minWidth: 100,
      render: (r) => String(r.reorderPoint),
    },
    {
      key: 'actions',
      header: 'Actions',
      minWidth: 120,
      render: (r) => (
        <StockActions
          canWrite={can('inventory:write')}
          receiveOnly
          onPick={(mode) =>
            ask({
              mode,
              variant: {
                id: r.variantId,
                sku: r.sku,
                label: variantLabel(r.productName, r.variantName),
              },
            })
          }
        />
      ),
    },
  ];
  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading low stock">
      {(query.data ?? []).length === 0 ? (
        <EmptyState title="Nothing is running low">
          Variants appear here when available stock falls to their reorder point.
        </EmptyState>
      ) : (
        <DataTable
          label="Low stock"
          columns={columns}
          rows={query.data ?? []}
          rowKey={(r) => r.variantId}
        />
      )}
    </QueryBoundary>
  );
}

function Movements() {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: ['movements'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.inventory.movements({ limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const columns: Column<Movement>[] = [
    { key: 'when', header: 'When', flex: 2, minWidth: 170, render: (m) => formatWhen(m.createdAt) },
    {
      key: 'type',
      header: 'Type',
      minWidth: 120,
      render: (m) => (
        <Badge tone={MOVEMENT_TONE[m.type]}>{m.type.toLowerCase().replace('_', ' ')}</Badge>
      ),
    },
    { key: 'sku', header: 'SKU', flex: 2, render: (m) => m.sku },
    {
      key: 'onHand',
      header: 'On hand',
      align: 'right',
      minWidth: 90,
      render: (m) => (m.onHandDelta ? signed(m.onHandDelta) : '—'),
    },
    {
      key: 'reserved',
      header: 'Reserved',
      align: 'right',
      minWidth: 90,
      render: (m) => (m.reservedDelta ? signed(m.reservedDelta) : '—'),
    },
    {
      key: 'damaged',
      header: 'Damaged',
      align: 'right',
      minWidth: 90,
      render: (m) => (m.damagedDelta ? signed(m.damagedDelta) : '—'),
    },
    {
      key: 'reason',
      header: 'Note',
      flex: 3,
      minWidth: 180,
      render: (m) => m.reason ?? m.referenceId ?? '—',
    },
  ];
  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading movements">
      {rows.length === 0 ? (
        <EmptyState title="No stock movements yet">
          Every change to stock is recorded here, newest first.
        </EmptyState>
      ) : (
        <Stack gap={4}>
          <DataTable label="Stock movements" columns={columns} rows={rows} rowKey={(m) => m.id} />
          <LoadMore
            hasNext={!!query.hasNextPage}
            loading={query.isFetchingNextPage}
            onPress={() => query.fetchNextPage()}
          />
        </Stack>
      )}
    </QueryBoundary>
  );
}

const RESERVATION_STATUS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'RELEASED', label: 'Released' },
  { value: 'FULFILLED', label: 'Fulfilled' },
];

function Reservations() {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'ACTIVE' | 'RELEASED' | 'FULFILLED'>('ACTIVE');
  const [working, setWorking] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['reservations', { status }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.reservations.list({ limit: 50, status, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  async function resolve(r: Reservation, action: 'release' | 'fulfil') {
    setWorking(r.id);
    try {
      if (action === 'release') await api.reservations.release(r.id);
      else await api.reservations.fulfil(r.id);
      await invalidateStock(queryClient);
      toast.success(
        action === 'release'
          ? 'Reservation released: the stock is available again'
          : 'Reservation fulfilled: the stock has left',
      );
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setWorking(null);
    }
  }

  const columns: Column<Reservation>[] = [
    {
      key: 'when',
      header: 'Created',
      flex: 2,
      minWidth: 170,
      render: (r) => formatWhen(r.createdAt),
    },
    { key: 'ref', header: 'Reference', flex: 2, render: (r) => r.referenceId ?? '—' },
    {
      key: 'qty',
      header: 'Quantity',
      align: 'right',
      minWidth: 90,
      render: (r) => String(r.quantity),
    },
    {
      key: 'status',
      header: 'Status',
      minWidth: 110,
      render: (r) => (
        <Badge
          tone={
            r.status === 'ACTIVE' ? 'warning' : r.status === 'FULFILLED' ? 'success' : 'neutral'
          }
        >
          {r.status.toLowerCase()}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      flex: 2,
      minWidth: 200,
      render: (r) =>
        r.status === 'ACTIVE' && can('inventory:write') ? (
          <Row gap={1} wrap>
            <Button
              size="sm"
              variant="secondary"
              loading={working === r.id}
              onPress={() => resolve(r, 'release')}
            >
              Release
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={working === r.id}
              onPress={() => resolve(r, 'fulfil')}
            >
              Fulfil
            </Button>
          </Row>
        ) : (
          '—'
        ),
    },
  ];
  return (
    <Stack gap={4}>
      <FieldGrid minWidth={240}>
        <SelectField
          label="Status"
          options={RESERVATION_STATUS}
          value={status}
          onChange={(v) => setStatus(v as typeof status)}
        />
      </FieldGrid>
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading reservations">
        {rows.length === 0 ? (
          <EmptyState title="No reservations here">
            Reserve stock from a product's page to hold it for an order.
          </EmptyState>
        ) : (
          <>
            <DataTable label="Reservations" columns={columns} rows={rows} rowKey={(r) => r.id} />
            <LoadMore
              hasNext={!!query.hasNextPage}
              loading={query.isFetchingNextPage}
              onPress={() => query.fetchNextPage()}
            />
          </>
        )}
      </QueryBoundary>
    </Stack>
  );
}

export function InventoryScreen() {
  const [tab, setTab] = useState<Tab>('levels');
  const [request, setRequest] = useState<Request>(null);
  return (
    <Stack gap={5}>
      <PageHeader
        title="Stock"
        description="How much of everything you have, where it is, and how it moved."
        actions={<ExportButtons kinds={['stock']} />}
      />
      <Tabs label="Stock views" items={TABS} value={tab} onChange={(v) => setTab(v as Tab)} />
      {tab === 'levels' && <Levels ask={setRequest} />}
      {tab === 'low' && <Low ask={setRequest} />}
      {tab === 'movements' && <Movements />}
      {tab === 'reservations' && <Reservations />}
      <StockDialog
        mode={request?.mode ?? 'receive'}
        variant={request?.variant ?? null}
        {...(request?.locationId ? { defaultLocationId: request.locationId } : {})}
        onClose={() => setRequest(null)}
      />
    </Stack>
  );
}
