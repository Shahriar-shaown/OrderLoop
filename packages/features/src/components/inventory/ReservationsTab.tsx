import type { Reservation, ReservationStatus } from '@orderloop/contracts';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  FilterMenu,
  LoadMore,
  Row,
  Stack,
  Text,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { messageFor } from '../../forms/errors';
import { formatWhen } from '../../lib/format';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { invalidateStock } from './StockDialog';

const STATUSES = [
  { value: 'RELEASED', label: 'Released' },
  { value: 'FULFILLED', label: 'Fulfilled' },
];

/** Stock held for an order, with release and fulfil. */
export function ReservationsTab() {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  // '' is the default view: the reservations still holding stock.
  const [chosen, setChosen] = useState('');
  const status = (chosen || 'ACTIVE') as ReservationStatus;
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

  const badge = (r: Reservation) => (
    <Badge
      dot
      tone={r.status === 'ACTIVE' ? 'warning' : r.status === 'FULFILLED' ? 'success' : 'neutral'}
    >
      {r.status.charAt(0) + r.status.slice(1).toLowerCase()}
    </Badge>
  );
  const actions = (r: Reservation) =>
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
    ) : null;

  const columns: Column<Reservation>[] = [
    {
      key: 'when',
      header: 'Created',
      flex: 2,
      minWidth: 160,
      render: (r) => formatWhen(r.createdAt),
    },
    {
      key: 'ref',
      header: 'Reference',
      flex: 2,
      minWidth: 140,
      render: (r) => r.referenceId ?? '—',
    },
    {
      key: 'qty',
      header: 'Quantity',
      align: 'right',
      minWidth: 90,
      render: (r) => <Text numeric>{String(r.quantity)}</Text>,
    },
    { key: 'status', header: 'Status', minWidth: 120, render: badge },
    { key: 'actions', header: 'Actions', flex: 2, minWidth: 200, render: (r) => actions(r) ?? '—' },
  ];
  return (
    <Stack gap={4}>
      <Row gap={3} wrap>
        <FilterMenu
          label="Status"
          value={chosen}
          options={STATUSES}
          onChange={setChosen}
          allLabel="Active"
        />
      </Row>
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading reservations">
        {rows.length === 0 ? (
          <EmptyState icon="lock" title="No reservations here">
            Reserve stock from a product's page to hold it for an order.
          </EmptyState>
        ) : (
          <>
            <DataTable
              label="Reservations"
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              renderCard={(r) => (
                <Stack gap={2}>
                  <Row justify="between" gap={2}>
                    <Text weight="medium">{r.referenceId ?? 'Manual hold'}</Text>
                    {badge(r)}
                  </Row>
                  <Text variant="small" tone="muted" numeric>
                    {`${r.quantity} reserved · ${formatWhen(r.createdAt)}`}
                  </Text>
                  {actions(r)}
                </Stack>
              )}
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
