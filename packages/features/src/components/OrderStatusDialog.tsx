import type { OrderDetail, OrderStatus } from '@orderloop/contracts';
import { REASON_REQUIRED } from '@orderloop/domain';
import { FormDialog, SelectField, Stack, Text, TextField, useToast } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useFormState } from '../forms';
import { invalidateOrders, STATUS_ACTION, STATUS_LABEL } from '../orders';
import { useApi } from '../runtime';

const CONDITIONS = [
  { value: 'RESALEABLE', label: 'Resaleable: back on the shelf' },
  { value: 'DAMAGED', label: 'Damaged: to the damaged bucket' },
];

const EFFECT: Partial<Record<OrderStatus, string>> = {
  confirmed: 'The stock for these items is set aside for this order.',
  cancelled: 'Any stock held for this order goes back on sale.',
  shipped: 'The held stock leaves with the courier.',
  returned: 'The returned goods are added back to your stock.',
};

function StatusForm({
  order,
  status,
  onClose,
}: {
  order: OrderDetail;
  status: OrderStatus;
  onClose: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const needsReason = REASON_REQUIRED.includes(status);
  const form = useFormState({ reason: '' });
  const [conditions, setConditions] = useState<Record<string, string>>({});

  async function submit() {
    const reason = form.values.reason.trim();
    if (needsReason && reason.length < 3)
      return form.setErrors({ reason: 'Say why (at least 3 characters)' });
    const ok = await form.run(async () => {
      await api.orders.changeStatus(order.id, {
        status,
        ...(reason ? { reason } : {}),
        ifVersion: order.version,
        ...(status === 'returned'
          ? {
              returnedItems: Object.entries(conditions).map(([itemId, condition]) => ({
                itemId,
                condition: condition as 'RESALEABLE' | 'DAMAGED',
              })),
            }
          : {}),
      });
      await invalidateOrders(queryClient);
    });
    if (ok) {
      toast.success(`Order #${order.orderNumber}: ${STATUS_LABEL[status].toLowerCase()}`);
      onClose();
    }
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      title={`${STATUS_ACTION[status]} #${order.orderNumber}`}
      onSubmit={submit}
      submitLabel={STATUS_ACTION[status]}
      busy={form.busy}
      error={form.formError}
      size="sm"
    >
      {EFFECT[status] && <Text>{EFFECT[status]}</Text>}
      {status === 'returned' && (
        <Stack gap={2}>
          {order.items.map((i) => (
            <SelectField
              key={i.id}
              label={`Condition: ${i.sku} × ${i.quantity}`}
              options={CONDITIONS}
              value={conditions[i.id] ?? 'RESALEABLE'}
              onChange={(v) => setConditions((c) => ({ ...c, [i.id]: v }))}
            />
          ))}
        </Stack>
      )}
      {(needsReason || status === 'confirmed') && (
        <TextField
          label={needsReason ? 'Reason' : 'Note (optional)'}
          required={needsReason}
          autoFocus
          placeholder={
            status === 'cancelled'
              ? 'Customer cancelled, no answer, out of stock…'
              : 'What happened?'
          }
          {...form.field('reason')}
        />
      )}
    </FormDialog>
  );
}

/** Move one order to a status, asking for the reason (and, for a return, each line's condition) where one is due. */
export function OrderStatusDialog({
  order,
  status,
  onClose,
}: {
  order: OrderDetail;
  status: OrderStatus | null;
  onClose: () => void;
}) {
  return status ? (
    <StatusForm key={`${order.id}:${status}`} order={order} status={status} onClose={onClose} />
  ) : null;
}
