import type { CustomerDetail } from '@orderloop/contracts';
import { Alert, Button, Section, Stack, Text } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { DangerDialog } from '../../forms/DangerDialog';
import { formatWhen } from '../../lib/format';
import { invalidateOrders } from '../../lib/orders';

/**
 * "Erase personal data" on a customer: for people who may (customers:erase), with a plain explanation and a typed
 * confirmation. After it the customer is a placeholder, and this says so. Technical behaviour, not a compliance statement.
 */
export function EraseCustomerSection({ customer }: { customer: CustomerDetail }) {
  const api = useApi();
  const can = useCan();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  if (customer.erasedAt)
    return (
      <Alert tone="info" title="Personal data erased">
        {`This customer’s personal data was erased on ${formatWhen(customer.erasedAt)}. The name and phone shown are placeholders. Orders keep their totals, statuses and dates.`}
      </Alert>
    );
  if (!can('customers:erase')) return null;

  return (
    <Section
      title="Personal data"
      description="Remove everything that identifies this customer, for example when they ask you to."
    >
      <Stack gap={3}>
        <Text tone="muted">
          Erasing removes the name, phone, email, notes and saved addresses, and the copy of the
          name, phone and address on every order, in OrderLoop. Order totals, statuses and dates
          stay, so your accounts still add up. Messages from Facebook or Instagram are deleted too.
          This cannot be undone.
        </Text>
        <Text tone="muted">
          A customer with an order in progress cannot be erased until it is delivered, cancelled or
          returned. Couriers and Meta keep their own copies, which OrderLoop cannot remove.
        </Text>
        <Stack direction="row">
          <Button variant="danger" icon="trash" onPress={() => setOpen(true)}>
            Erase personal data
          </Button>
        </Stack>
      </Stack>
      <DangerDialog
        open={open}
        title="Erase this customer’s personal data?"
        submitLabel="Erase personal data"
        confirmText={{ label: 'Type ERASE to confirm', expected: 'ERASE' }}
        reason={{
          label: 'Reason (optional)',
          hint: 'Kept in the audit trail. Do not write other personal details here.',
        }}
        success="Personal data erased"
        onSubmit={async ({ reason }) => {
          await api.customers.erase(customer.id, { confirm: true, ...(reason ? { reason } : {}) });
          await invalidateOrders(queryClient);
        }}
        onClose={() => setOpen(false)}
      >
        <Text>
          This customer’s name, phone, email, notes and addresses will be removed everywhere in
          OrderLoop. It cannot be undone.
        </Text>
      </DangerDialog>
    </Section>
  );
}
