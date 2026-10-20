import type { Customer } from '@orderloop/contracts';
import { formatBdPhone } from '@orderloop/domain';
import {
  Button,
  DataTable,
  EmptyState,
  Link,
  LoadMore,
  PageHeader,
  Row,
  SearchField,
  Stack,
  Text,
  useNavigation,
  type Column,
} from '@orderloop/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CustomerDialog } from '../../components/orders/CustomerDialog';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { formatDayTime } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { formatPrice } from '../../lib/money';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';

/** `openNew` opens the new-customer form straight away (the create menu links here with it). */
export function CustomersScreen({ openNew = false }: { openNew?: boolean } = {}) {
  const api = useApi();
  const can = useCan();
  const navigation = useNavigation();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(openNew && can('orders:write'));
  // The create menu links here with ?new=1, also while this page is already open.
  const canAdd = can('orders:write');
  useEffect(() => {
    if (openNew && canAdd) setAdding(true);
  }, [openNew, canAdd]);
  const q = useDebounced(search.trim());
  const customers = useInfiniteQuery({
    queryKey: ['customers', { q }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.customers.list({
        limit: 25,
        ...(q ? { q } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = customers.data?.pages.flatMap((p) => p.items) ?? [];

  const columns: Column<Customer>[] = [
    {
      key: 'name',
      header: 'Customer',
      flex: 3,
      minWidth: 200,
      render: (c) => (
        <Stack gap={1}>
          <Link href={`/customers/${c.id}`} weight="medium">
            {c.name}
          </Link>
          <Text variant="caption" tone="muted">
            {formatBdPhone(c.phone)}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'orders',
      header: 'Orders',
      align: 'right',
      minWidth: 80,
      render: (c) => <Text numeric>{String(c.stats.ordersCount)}</Text>,
    },
    {
      key: 'delivered',
      header: 'Delivered',
      align: 'right',
      minWidth: 90,
      show: 'wide',
      render: (c) => <Text numeric>{String(c.stats.deliveredCount)}</Text>,
    },
    {
      key: 'returned',
      header: 'Returned',
      align: 'right',
      minWidth: 90,
      show: 'wide',
      render: (c) => <Text numeric>{String(c.stats.returnedCount)}</Text>,
    },
    {
      key: 'value',
      header: 'Delivered value',
      align: 'right',
      minWidth: 130,
      render: (c) => (
        <Text numeric weight="medium">
          {formatPrice(c.stats.deliveredValueMinor)}
        </Text>
      ),
    },
    {
      key: 'last',
      header: 'Last order',
      flex: 2,
      minWidth: 140,
      show: 'wide',
      render: (c) => (
        <Text tone="muted" numeric>
          {c.stats.lastOrderAt ? formatDayTime(c.stats.lastOrderAt) : '—'}
        </Text>
      ),
    },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Customers"
        description="People who order from you. A phone number is one customer."
        actions={
          can('orders:write') ? (
            <Button icon="plus" onPress={() => setAdding(true)}>
              New customer
            </Button>
          ) : undefined
        }
      />
      <Row>
        <Stack grow style={{ maxWidth: 480 }}>
          <SearchField
            label="Search"
            placeholder="Name or phone"
            value={search}
            onChangeText={setSearch}
          />
        </Stack>
      </Row>
      {customers.isError ? (
        <QueryBoundary
          isPending={false}
          isError
          error={customers.error}
          refetch={() => customers.refetch()}
        >
          {null}
        </QueryBoundary>
      ) : (
        <Stack gap={3}>
          <DataTable
            label="Customers"
            columns={columns}
            rows={rows}
            rowKey={(c) => c.id}
            loading={customers.isPending}
            onRowPress={(c) => navigation.push(`/customers/${c.id}`)}
            rowLabel={(c) => c.name}
            renderCard={(c) => (
              <Stack gap={1}>
                <Row justify="between" gap={2}>
                  <Link href={`/customers/${c.id}`} weight="medium">
                    {c.name}
                  </Link>
                  <Text numeric weight="medium">
                    {formatPrice(c.stats.deliveredValueMinor)}
                  </Text>
                </Row>
                <Text variant="caption" tone="muted">
                  {`${formatBdPhone(c.phone)} · ${c.stats.ordersCount} order${c.stats.ordersCount === 1 ? '' : 's'}`}
                </Text>
              </Stack>
            )}
            empty={
              <EmptyState icon="users" title={q ? 'No customers match' : 'No customers yet'}>
                {q
                  ? 'Try a different name or number.'
                  : 'Customers appear here when you take an order, or add one yourself.'}
              </EmptyState>
            }
          />
          <LoadMore
            hasNext={!!customers.hasNextPage}
            loading={customers.isFetchingNextPage}
            onPress={() => customers.fetchNextPage()}
          />
        </Stack>
      )}
      <CustomerDialog
        customer={null}
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={(c) => navigation.push(`/customers/${c.id}`)}
      />
    </Stack>
  );
}
