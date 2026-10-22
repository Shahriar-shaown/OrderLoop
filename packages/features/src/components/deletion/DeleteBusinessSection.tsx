import { Alert, Button, Section, Stack, Text } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../../core/auth';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { DangerDialog } from '../../forms/DangerDialog';
import { ExportButtons } from '../../shell/ExportButtons';
import { formatWhen } from '../../lib/format';
import { useSetTenantDeletion, useTenantDeletion } from '../../lib/deletion';

/**
 * "Delete this business" for owners (tenant:delete): a typed business name and the password, then the business is blocked
 * for everyone and deleted for good after the grace period unless the owner cancels. Takes the data export first.
 */
export function DeleteBusinessSection() {
  const api = useApi();
  const can = useCan();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const status = useTenantDeletion(can('tenant:delete'));
  const setStatus = useSetTenantDeletion();
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  if (!can('tenant:delete') || !session) return null;
  const graceDays = status.data?.graceDays ?? 14;

  if (status.data?.scheduled)
    return (
      <Section title="Delete this business">
        <Alert
          tone="warning"
          title="This business is scheduled for deletion"
          action={
            status.data.canCancel ? (
              <Button
                variant="secondary"
                size="sm"
                loading={cancelling}
                onPress={async () => {
                  setCancelling(true);
                  setCancelError('');
                  try {
                    setStatus(await api.tenantDeletion.cancel());
                    await queryClient.invalidateQueries();
                  } catch {
                    setCancelError('The deletion could not be cancelled. Try again.');
                  } finally {
                    setCancelling(false);
                  }
                }}
              >
                Cancel deletion
              </Button>
            ) : undefined
          }
        >
          {`It will be deleted for good on ${formatWhen(status.data.purgeAfter!)}.`}
        </Alert>
        {cancelError ? <Alert tone="error">{cancelError}</Alert> : null}
      </Section>
    );

  return (
    <Section
      title="Delete this business"
      description="Delete the business and everything in it: orders, customers, products, stock, finance records and settings."
    >
      <Stack gap={3}>
        <Text tone="muted">
          {`Nobody can use the business as soon as you ask. Courier credentials and Meta connections are deleted at once and automation stops. Everything is deleted for good after ${graceDays} days; until then you can cancel. Take your data first: the files below are the customer list, orders, products and stock.`}
        </Text>
        <ExportButtons kinds={['customers', 'orders', 'products', 'stock']} />
        <Text tone="muted">
          Backups made before the deletion are kept until they expire, and your couriers and Meta
          keep their own copies, which OrderLoop cannot remove.
        </Text>
        <Stack direction="row">
          <Button variant="danger" icon="trash" onPress={() => setOpen(true)}>
            Delete this business
          </Button>
        </Stack>
      </Stack>
      <DangerDialog
        open={open}
        title="Delete this business?"
        submitLabel="Delete this business"
        confirmText={{
          label: 'Type the business name to confirm',
          expected: session.tenant.name,
          hint: session.tenant.name,
        }}
        password
        onSubmit={async ({ password }) => {
          const next = await api.tenantDeletion.request({
            confirmName: session.tenant.name,
            password,
          });
          setStatus(next);
        }}
        onClose={() => setOpen(false)}
      >
        <Text>
          {`Everyone in this business is blocked at once, and it is deleted for good after ${graceDays} days. You can cancel until then.`}
        </Text>
      </DangerDialog>
    </Section>
  );
}
