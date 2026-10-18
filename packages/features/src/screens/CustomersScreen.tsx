import type { Customer } from '@orderloop/contracts';
import { formatBdPhone } from '@orderloop/domain';
import {
  Button,
  DataTable,
  EmptyState,
  Link,
  LoadMore,
  PageHeader,
  Stack,
  Text,
  TextField,
  useNavigation,
  type Column,
} from '@orderloop/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CustomerDialog } from '../components/CustomerDialog';
import { QueryBoundary } from '../components/QueryBoundary';
import { formatWhen } from '../format';
import { useDebounced } from '../hooks';
import { formatPrice } from '../money';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

export function CustomersScreen() {
  const api = useApi();
  const can = useCan();
  const navigation = useNavigation();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
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
      render: (c) => String(c.stats.ordersCount),
    },
    {
      key: 'delivered',
      header: 'Delivered',
      align: 'right',
      minWidth: 90,
      render: (c) => String(c.stats.deliveredCount),
    },
    {
      key: 'returned',
      header: 'Returned',
      align: 'right',
      minWidth: 90,
      render: (c) => String(c.stats.returnedCount),
    },
    {
      key: 'value',
      header: 'Delivered value',
      align: 'right',
      minWidth: 130,
      render: (c) => formatPrice(c.stats.deliveredValueMinor),
    },
    {
      key: 'last',
      header: 'Last order',
      flex: 2,
      minWidth: 150,
      render: (c) => (c.stats.lastOrderAt ? formatWhen(c.stats.lastOrderAt) : '—'),
    },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Customers"
        description="People who order from you. A phone number is one customer."
        actions={
          can('orders:write') ? (
            <Button onPress={() => setAdding(true)}>New customer</Button>
          ) : undefined
        }
      />
      <TextField
        label="Search"
        kind="search"
        placeholder="Name or phone"
        value={search}
        onChangeText={setSearch}
      />
      <QueryBoundary {...customers} refetch={() => customers.refetch()} label="Loading customers">
        {rows.length === 0 ? (
          <EmptyState title={q ? 'No customers match' : 'No customers yet'}>
            {q
              ? 'Try a different name or number.'
              : 'Customers appear here when you take an order, or add one yourself.'}
          </EmptyState>
        ) : (
          <>
            <DataTable label="Customers" columns={columns} rows={rows} rowKey={(c) => c.id} />
            <LoadMore
              hasNext={!!customers.hasNextPage}
              loading={customers.isFetchingNextPage}
              onPress={() => customers.fetchNextPage()}
            />
          </>
        )}
      </QueryBoundary>
      <CustomerDialog
        customer={null}
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={(c) => navigation.push(`/customers/${c.id}`)}
      />
    </Stack>
  );
}
