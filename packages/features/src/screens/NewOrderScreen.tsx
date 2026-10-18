import { Alert, PageHeader, Stack } from '@orderloop/ui';
import { OrderForm } from '../components/OrderForm';
import { useCan } from '../permissions';

/** Take a new order. Pass `customerId` to start from an existing customer. */
export function NewOrderScreen({ customerId }: { customerId?: string | undefined }) {
  const can = useCan();
  if (!can('orders:write'))
    return <Alert tone="warning">Your role can view orders but not create them.</Alert>;
  return (
    <Stack gap={5}>
      <PageHeader
        title="New order"
        description="Customer, delivery address and items. Totals are worked out by the server."
      />
      <OrderForm {...(customerId ? { customerId } : {})} />
    </Stack>
  );
}
