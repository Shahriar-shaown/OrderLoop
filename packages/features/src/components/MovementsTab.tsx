import type { Movement, MovementType } from '@orderloop/contracts';
import {
  Badge,
  DataTable,
  EmptyState,
  FilterMenu,
  LoadMore,
  Row,
  Stack,
  Text,
  type Column,
  type Tone,
} from '@orderloop/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { formatWhen } from '../format';
import { useLocations } from '../hooks';
import { useApi } from '../runtime';
import { QueryBoundary } from './QueryBoundary';

const TYPE: Record<MovementType, { label: string; tone: Tone }> = {
  RECEIVE: { label: 'Received', tone: 'success' },
  ADJUSTMENT: { label: 'Adjustment', tone: 'warning' },
  RESERVE: { label: 'Reserved', tone: 'info' },
  RELEASE: { label: 'Released', tone: 'neutral' },
  SHIP: { label: 'Sold · shipped', tone: 'neutral' },
  DAMAGE: { label: 'Damaged', tone: 'error' },
  WRITE_OFF: { label: 'Written off', tone: 'neutral' },
  RETURN: { label: 'Returned', tone: 'success' },
};
const TYPE_OPTIONS = (Object.keys(TYPE) as MovementType[]).map((t) => ({
  value: t,
  label: TYPE[t].label,
}));
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** The headline change of a movement: the on-hand change, or the reserved / damaged one when that is what moved. */
function change(m: Movement): { text: string; note: string | null } {
  if (m.onHandDelta) return { text: signed(m.onHandDelta), note: null };
  if (m.reservedDelta) return { text: signed(m.reservedDelta), note: 'reserved' };
  if (m.damagedDelta) return { text: signed(m.damagedDelta), note: 'damaged' };
  return { text: '0', note: null };
}

const detail = (m: Movement) => m.reason ?? m.referenceId ?? '—';

function ChangeCell({ m }: { m: Movement }) {
  const c = change(m);
  return (
    <Row gap={1} align="center">
      <Text weight="medium" numeric>
        {c.text.replace('-', '−')}
      </Text>
      {c.note ? (
        <Text variant="caption" tone="muted">
          {c.note}
        </Text>
      ) : null}
    </Row>
  );
}

/** The stock ledger, newest first. */
export function MovementsTab() {
  const api = useApi();
  const locations = useLocations();
  const [type, setType] = useState('');
  const [locationId, setLocationId] = useState('');
  const locationOptions = useMemo(
    () => (locations.data ?? []).map((l) => ({ value: l.id, label: l.name })),
    [locations.data],
  );
  const query = useInfiniteQuery({
    queryKey: ['movements', { type, locationId }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.inventory.movements({
        limit: 50,
        ...(type ? { type: type as MovementType } : {}),
        ...(locationId ? { locationId } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const columns: Column<Movement>[] = [
    { key: 'when', header: 'When', flex: 2, minWidth: 160, render: (m) => formatWhen(m.createdAt) },
    {
      key: 'sku',
      header: 'SKU',
      flex: 2,
      minWidth: 130,
      render: (m) => <Text weight="medium">{m.sku}</Text>,
    },
    {
      key: 'type',
      header: 'Type',
      flex: 2,
      minWidth: 140,
      render: (m) => (
        <Badge tone={TYPE[m.type].tone} dot>
          {TYPE[m.type].label}
        </Badge>
      ),
    },
    {
      key: 'change',
      header: 'Change',
      align: 'right',
      minWidth: 100,
      render: (m) => <ChangeCell m={m} />,
    },
    {
      key: 'reason',
      header: 'Reason / reference',
      flex: 3,
      minWidth: 200,
      show: 'wide',
      render: detail,
    },
  ];
  return (
    <Stack gap={4}>
      <Row gap={3} wrap>
        <FilterMenu label="Type" value={type} options={TYPE_OPTIONS} onChange={setType} />
        <FilterMenu
          label="Location"
          value={locationId}
          options={locationOptions}
          onChange={setLocationId}
        />
      </Row>
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading movements">
        {rows.length === 0 ? (
          <EmptyState icon="list" title="No stock movements here">
            Every change to stock is recorded here, newest first.
          </EmptyState>
        ) : (
          <>
            <DataTable
              label="Stock movements"
              columns={columns}
              rows={rows}
              rowKey={(m) => m.id}
              renderCard={(m) => (
                <Stack gap={2}>
                  <Row justify="between" gap={2}>
                    <Text weight="medium">{m.sku}</Text>
                    <ChangeCell m={m} />
                  </Row>
                  <Row justify="between" gap={2} wrap>
                    <Badge tone={TYPE[m.type].tone} dot>
                      {TYPE[m.type].label}
                    </Badge>
                    <Text variant="caption" tone="muted">
                      {formatWhen(m.createdAt)}
                    </Text>
                  </Row>
                  <Text variant="small" tone="muted">
                    {detail(m)}
                  </Text>
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
