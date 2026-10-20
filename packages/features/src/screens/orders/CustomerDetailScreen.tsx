import type { AddressRecord } from '@orderloop/contracts';
import { formatBdPhone } from '@orderloop/domain';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Grid,
  KeyValueList,
  Link,
  LoadMore,
  PageHeader,
  Row,
  Section,
  Split,
  Stack,
  StatCard,
  Text,
  useNavigation,
  useToast,
} from '@orderloop/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AddressDialog } from '../../components/orders/AddressDialog';
import { CustomerDialog } from '../../components/orders/CustomerDialog';
import { OrderCard, orderColumns } from '../../components/orders/OrderListParts';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { messageFor } from '../../forms/errors';
import { formatPrice } from '../../lib/money';
import { invalidateOrders, useCustomer } from '../../lib/orders';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';

export function CustomerDetailScreen({ id }: { id: string }) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const navigation = useNavigation();
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

  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading customer">
      {customer && (
        <Stack gap={5}>
          <PageHeader
            breadcrumbs={[{ label: 'Customers', href: '/customers' }, { label: customer.name }]}
            title={customer.name}
            description={formatBdPhone(customer.phone)}
            actions={
              <>
                {writable && (
                  <Button variant="secondary" icon="edit" onPress={() => setEditing(true)}>
                    Edit
                  </Button>
                )}
                {writable && (
                  <Button icon="plus" href={`/orders/new?customerId=${customer.id}`}>
                    Create order
                  </Button>
                )}
              </>
            }
          />
          <Grid columns={{ mobile: 2, tablet: 3, desktop: 5 }}>
            <StatCard label="Orders" value={String(customer.stats.ordersCount)} />
            <StatCard label="Delivered" value={String(customer.stats.deliveredCount)} />
            <StatCard label="Cancelled" value={String(customer.stats.cancelledCount)} />
            <StatCard label="Returned" value={String(customer.stats.returnedCount)} />
            <StatCard
              label="Delivered value"
              value={formatPrice(customer.stats.deliveredValueMinor)}
              hint="Orders delivered, not cash collected"
            />
          </Grid>
          <Text variant="caption" tone="muted">
            Plain counts of what has happened. OrderLoop never labels or scores a customer.
          </Text>
          <Split
            asideWidth={400}
            main={
              <Section
                title="Orders"
                description={`${total} order${total === 1 ? '' : 's'}, newest first.`}
              >
                {history.isError ? (
                  <QueryBoundary
                    isPending={false}
                    isError
                    error={history.error}
                    refetch={() => history.refetch()}
                  >
                    {null}
                  </QueryBoundary>
                ) : (
                  <Stack gap={3}>
                    <DataTable
                      label="Customer orders"
                      columns={orderColumns({ customer: false })}
                      rows={orders}
                      rowKey={(o) => o.id}
                      loading={history.isPending}
                      onRowPress={(o) => navigation.push(`/orders/${o.id}`)}
                      renderCard={(o) => <OrderCard order={o} showCustomer={false} />}
                      empty={<EmptyState icon="box" title="No orders yet" />}
                    />
                    <LoadMore
                      hasNext={!!history.hasNextPage}
                      loading={history.isFetchingNextPage}
                      onPress={() => history.fetchNextPage()}
                    />
                  </Stack>
                )}
              </Section>
            }
            aside={
              <>
                <Section title="Contact">
                  <KeyValueList
                    layout="inline"
                    items={[
                      {
                        label: 'Phone',
                        value: (
                          <Link href={`tel:${customer.phone}`} external>
                            {formatBdPhone(customer.phone)}
                          </Link>
                        ),
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
                      <Button
                        variant="secondary"
                        size="sm"
                        onPress={() => setAddress({ value: null })}
                      >
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
              </>
            }
          />
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
