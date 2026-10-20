import { Alert, Button, PageHeader, Stack } from '@orderloop/ui';
import { OrderForm } from '../../components/orders/OrderForm';
import { useCan } from '../../core/permissions';

/** Take a new order. Pass `customerId` to start from an existing customer. */
export function NewOrderScreen({ customerId }: { customerId?: string | undefined }) {
  const can = useCan();
  if (!can('orders:write'))
    return <Alert tone="warning">Your role can view orders but not create them.</Alert>;
  return (
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[{ label: 'Orders', href: '/orders' }, { label: 'Create order' }]}
        title="Create order"
        description="Add a customer, products and payment. Totals update as you type."
        actions={
          <Button variant="tertiary" href="/orders">
            Cancel
          </Button>
        }
      />
      <OrderForm {...(customerId ? { customerId } : {})} />
    </Stack>
  );
}
