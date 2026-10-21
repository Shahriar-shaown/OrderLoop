import type { OrderDetail, OrderStatus } from '@orderloop/contracts';
import { REASON_REQUIRED } from '@orderloop/domain';
import { Alert, FormDialog, Stack, Text, TextField, useT, useToast } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useFormState } from '../../forms/forms';
import { hasReason, REASON_ERROR } from '../../forms/ReasonDialog';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { CLOSE_STATUSES, invalidateOrders, STATUS_ACTION, STATUS_LABEL } from '../../lib/orders';
import {
  lineName,
  returnedQuantity,
  returnLineErrors,
  returnPlan,
  startingPicks,
  type ReturnPick,
} from '../../lib/returns';
import { ReturnLines } from './ReturnLines';

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
  const t = useT();
  const [picks, setPicks] = useState(() => startingPicks(order.items));
  const plan = returnPlan(order.items, picks);
  const lineErrors = returnLineErrors(form.errors, plan.entries);

  /** "Returning 1 of 2 Red / M; 0 of 1 Blue / L": what the person is about to tell the server. */
  const summary = `${t('Returning')} ${order.items
    .map(
      (i) =>
        `${t('{a} of {b}', { a: returnedQuantity(i, picks[i.id]), b: i.quantity })} ${lineName(i)}`,
    )
    .join('; ')}`;

  async function submit() {
    const reason = form.values.reason.trim();
    if (needsReason && !hasReason(reason)) return form.setErrors({ reason: REASON_ERROR });
    if (status === 'returned' && plan.nothing) {
      return form.setFormError('Say how many of at least one item came back.');
    }
    const ok = await form.run(async () => {
      await api.orders.changeStatus(order.id, {
        status,
        ...(reason ? { reason } : {}),
        ifVersion: order.version,
        ...(status === 'returned' && plan.returnedItems
          ? { returnedItems: plan.returnedItems }
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
        <Stack gap={3}>
          <Text variant="caption" tone="muted">
            Say how many of each item came back. Items you set to 0 add nothing to your stock.
          </Text>
          <ReturnLines
            items={order.items}
            picks={picks}
            errors={lineErrors}
            onChange={(id: string, pick: ReturnPick) => setPicks((p) => ({ ...p, [id]: pick }))}
          />
          <Alert tone="info">{summary}</Alert>
        </Stack>
      )}
      {(needsReason || status === 'confirmed') && (
        <TextField
          label={needsReason ? 'Reason' : 'Note (optional)'}
          required={needsReason}
          autoFocus={status !== 'returned'}
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
  const can = useCan();
  // Delivered and Returned need `orders:close`. Their buttons are hidden without it; this is the last line of defence.
  if (status && CLOSE_STATUSES.includes(status) && !can('orders:close')) return null;
  return status ? (
    <StatusForm key={`${order.id}:${status}`} order={order} status={status} onClose={onClose} />
  ) : null;
}
