import type { Reservation, ReservationStatus } from '@orderloop/contracts';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  FilterMenu,
  Link,
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
import { invalidateCatalog } from '../../lib/invalidate';

/** The reference type of the holds that TikTok orders make. Only the TikTok order moves them (the API refuses a hand release or fulfil). */
const TIKTOK_REFERENCE = 'tiktok_order';
const isTikTok = (r: Reservation) => r.referenceType === TIKTOK_REFERENCE;

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
      await invalidateCatalog(queryClient);
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
  /** Where a reservation comes from: a TikTok order links to it, anything else shows its reference as written. */
  const reference = (r: Reservation) =>
    isTikTok(r) ? (
      <Row gap={2} wrap>
        <Badge tone="info">TikTok order</Badge>
        {r.referenceId && can('orders:read') && (
          <Link href={`/tiktok-orders/${r.referenceId}`} variant="inline">
            Open the order
          </Link>
        )}
      </Row>
    ) : (
      (r.referenceId ?? '—')
    );
  const actions = (r: Reservation) =>
    r.status !== 'ACTIVE' || !can('inventory:write') ? null : isTikTok(r) ? (
      <Text variant="small" tone="muted">
        Held by a TikTok order: it is released or shipped by TikTok’s status, not by hand.
      </Text>
    ) : (
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
    );

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
      render: reference,
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
                    {isTikTok(r) ? (
                      reference(r)
                    ) : (
                      <Text weight="medium">{r.referenceId ?? 'Manual hold'}</Text>
                    )}
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
