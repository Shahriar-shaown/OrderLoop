import { Alert, PageHeader, Stack } from '@orderloop/ui';
import { editScope } from '@orderloop/domain';
import { OrderForm } from '../../components/orders/OrderForm';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { useOrder } from '../../lib/orders';
import { useCan } from '../../core/permissions';

const SCOPE_NOTE = {
  full: 'Items, amounts, address and notes can all change while the order is pending confirmation.',
  contact:
    'Stock is held for this order, so items and amounts are frozen. The address and notes can change.',
  notes: 'This order has shipped. Only the notes can change.',
  none: 'This order is finished and can no longer be edited.',
} as const;

export function EditOrderScreen({ id }: { id: string }) {
  const can = useCan();
  const query = useOrder(id);
  const order = query.data;
  if (!can('orders:write'))
    return <Alert tone="warning">Your role can view orders but not change them.</Alert>;
  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading order">
      {order && (
        <Stack gap={5}>
          <PageHeader
            breadcrumbs={[
              { label: 'Orders', href: '/orders' },
              { label: `#${order.orderNumber}`, href: `/orders/${order.id}` },
              { label: 'Edit' },
            ]}
            title={`Edit order #${order.orderNumber}`}
            description={SCOPE_NOTE[editScope(order.status)]}
          />
          {editScope(order.status) === 'none' ? (
            <Alert tone="info">{SCOPE_NOTE.none}</Alert>
          ) : (
            <OrderForm key={order.version} order={order} />
          )}
        </Stack>
      )}
    </QueryBoundary>
  );
}
