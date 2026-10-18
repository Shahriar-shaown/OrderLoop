import type { AddressRecord, OrderSummary } from '@orderloop/contracts';
import { formatBdPhone } from '@orderloop/domain';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  KeyValueList,
  Link,
  LoadMore,
  PageHeader,
  Row,
  Section,
  Stack,
  Text,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AddressDialog } from '../components/AddressDialog';
import { CustomerDialog } from '../components/CustomerDialog';
import { OrderStatusBadge } from '../components/OrderStatusBadge';
import { QueryBoundary } from '../components/QueryBoundary';
import { messageFor } from '../errors';
import { formatWhen } from '../format';
import { formatPrice } from '../money';
import { invalidateOrders, useCustomer } from '../orders';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

export function CustomerDetailScreen({ id }: { id: string }) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useCustomer(id);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState<{ value: AddressRecord | null } | null>(null);
  const [removing, setRemoving] = useState<AddressRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const customer = query.data;
  const writable = can('orders:write');

  const history = useInfiniteQuery({
    queryKey: ['customerOrders', id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.customers.orders(id, { limit: 10, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const orders = history.data?.pages.flatMap((p) => p.items) ?? [];
  const total = history.data?.pages[0]?.total ?? 0;

  async function makeDefault(a: AddressRecord) {
    try {
      await api.customers.updateAddress(id, a.id, { isDefault: true });
      await invalidateOrders(queryClient);
    } catch (error) {
      toast.error(messageFor(error));
    }
  }
  async function remove(a: AddressRecord) {
    setBusy(true);
    try {
      await api.customers.removeAddress(id, a.id);
      await invalidateOrders(queryClient);
      toast.success('Address removed');
      setRemoving(null);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<OrderSummary>[] = [
    {
      key: 'n',
      header: 'Order',
      minWidth: 100,
      render: (o) => <Link href={`/orders/${o.id}`} weight="medium">{`#${o.orderNumber}`}</Link>,
    },
    {
      key: 's',
      header: 'Status',
      minWidth: 170,
      flex: 2,
      render: (o) => <OrderStatusBadge status={o.status} />,
    },
    { key: 'i', header: 'Items', align: 'right', minWidth: 70, render: (o) => String(o.itemCount) },
    {
      key: 't',
      header: 'Total',
      align: 'right',
      minWidth: 120,
      render: (o) => formatPrice(o.totalMinor),
    },
    { key: 'w', header: 'Created', flex: 2, minWidth: 160, render: (o) => formatWhen(o.createdAt) },
  ];

  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading customer">
      {customer && (
        <Stack gap={5}>
          <PageHeader
            title={customer.name}
            description={formatBdPhone(customer.phone)}
            actions={
              <Row gap={2} wrap>
                <Button href="/customers" variant="secondary">
                  Back to customers
                </Button>
                {writable && (
                  <Button variant="secondary" onPress={() => setEditing(true)}>
                    Edit
                  </Button>
                )}
                {writable && (
                  <Button href={`/orders/new?customerId=${customer.id}`}>New order</Button>
                )}
              </Row>
            }
          />
          <Section
            title="Order history in numbers"
            description="Plain counts of what has happened. OrderLoop never labels or scores a customer."
          >
            <KeyValueList
              items={[
                { label: 'Orders', value: String(customer.stats.ordersCount) },
                { label: 'Delivered', value: String(customer.stats.deliveredCount) },
                { label: 'Cancelled', value: String(customer.stats.cancelledCount) },
                { label: 'Returned', value: String(customer.stats.returnedCount) },
                {
                  label: 'Value of delivered orders',
                  value: formatPrice(customer.stats.deliveredValueMinor),
                },
                ...(customer.email ? [{ label: 'Email', value: customer.email }] : []),
                ...(customer.notes ? [{ label: 'Notes', value: customer.notes }] : []),
              ]}
            />
          </Section>
          <Section
            title="Addresses"
            actions={
              writable ? (
                <Button variant="secondary" onPress={() => setAddress({ value: null })}>
                  Add address
                </Button>
              ) : undefined
            }
          >
            {customer.addresses.length === 0 ? (
              <Text tone="muted">
                No saved addresses yet. One is saved automatically with the first order.
              </Text>
            ) : (
              customer.addresses.map((a) => (
                <Stack key={a.id} gap={1}>
                  <Row gap={2} wrap>
                    <Text weight="bold">{a.label ?? a.recipientName}</Text>
                    {a.isDefault && <Badge tone="info">Default</Badge>}
                  </Row>
                  <Text>{`${a.recipientName}, ${formatBdPhone(a.phone)}`}</Text>
                  <Text>{`${a.line1}, ${a.area}, ${a.district}, ${a.division}${a.postalCode ? ` ${a.postalCode}` : ''}`}</Text>
                  {writable && (
                    <Row gap={1} wrap>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => setAddress({ value: a })}
                      >
                        Edit
                      </Button>
                      {!a.isDefault && (
                        <Button size="sm" variant="secondary" onPress={() => makeDefault(a)}>
                          Make default
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onPress={() => setRemoving(a)}>
                        Remove
                      </Button>
                    </Row>
                  )}
                </Stack>
              ))
            )}
          </Section>
          <Section
            title="Orders"
            description={`${total} order${total === 1 ? '' : 's'}, newest first.`}
          >
            <QueryBoundary {...history} refetch={() => history.refetch()} label="Loading orders">
              {orders.length === 0 ? (
                <Text tone="muted">No orders yet.</Text>
              ) : (
                <>
                  <DataTable
                    label="Customer orders"
                    columns={columns}
                    rows={orders}
                    rowKey={(o) => o.id}
                  />
                  <LoadMore
                    hasNext={!!history.hasNextPage}
                    loading={history.isFetchingNextPage}
                    onPress={() => history.fetchNextPage()}
                  />
                </>
              )}
            </QueryBoundary>
          </Section>
          <CustomerDialog customer={customer} open={editing} onClose={() => setEditing(false)} />
          <AddressDialog
            customerId={customer.id}
            address={address?.value ?? null}
            defaults={{ name: customer.name, phone: customer.phone }}
            open={address !== null}
            onClose={() => setAddress(null)}
          />
          <ConfirmDialog
            open={removing !== null}
            title="Remove this address?"
            confirmLabel="Remove"
            danger
            busy={busy}
            onClose={() => setRemoving(null)}
            onConfirm={() => removing && remove(removing)}
          >
            Past orders keep the address they were made with.
          </ConfirmDialog>
        </Stack>
      )}
    </QueryBoundary>
  );
}
