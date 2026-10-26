import type { CodReceipt, OrderCash } from '@orderloop/contracts';
import {
  Button,
  DataTable,
  FormDialog,
  Row,
  Section,
  Stack,
  Text,
  TextField,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { useFormState } from '../../forms/forms';
import { hasReason, REASON_ERROR } from '../../forms/ReasonDialog';
import { useIdempotencyKey } from '../../forms/useIdempotencyKey';
import { invalidateFinance } from '../../lib/finance';
import { dayBefore } from '../../lib/format';
import { formatPrice, parsePrice } from '../../lib/money';
import { QueryBoundary } from '../../shell/QueryBoundary';

/**
 * Record cash the business collected itself for a delivered order (its own rider, a hand-over, a pick-up). It counts as
 * collected next to what courier statements report, so it is for cash no courier handled, or one that has not reported yet.
 * The amount starts as everything still due; a smaller one is a part payment.
 */
export function RecordCashDialog({
  orderId,
  orderNumber,
  outstandingMinor,
  open,
  onClose,
}: {
  orderId: string;
  orderNumber: number;
  outstandingMinor: number;
  open: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({
    amount: (outstandingMinor / 100).toFixed(2),
    receivedOn: dayBefore(0),
    note: '',
  });
  const { key, renew } = useIdempotencyKey();
  if (!open) return null;
  async function submit() {
    const amount = parsePrice(form.values.amount);
    if (amount === null || amount <= 0)
      return form.setErrors({ amount: 'Enter an amount in taka, like 450 or 450.50' });
    if (amount > outstandingMinor)
      return form.setErrors({
        amount: `That is more than the ${formatPrice(outstandingMinor)} still due`,
      });
    const note = form.values.note.trim();
    const ok = await form.run(async () => {
      await api.finance.createCodReceipt(orderId, {
        amountMinor: amount,
        receivedOn: form.values.receivedOn.trim(),
        ...(note ? { note } : {}),
        idempotencyKey: key,
      });
      await invalidateFinance(queryClient);
    });
    if (ok) {
      renew();
      toast.success(`Cash recorded for order #${orderNumber}`);
      onClose();
    }
  }
  return (
    <FormDialog
      open
      onClose={onClose}
      title={`Record cash collected: order #${orderNumber}`}
      onSubmit={submit}
      submitLabel="Record cash"
      busy={form.busy}
      error={form.formError}
    >
      <Text tone="muted">{`Still due: ${formatPrice(outstandingMinor)}. Record only cash you have actually received. A smaller amount is a part payment.`}</Text>
      <TextField
        label="Amount received (৳)"
        required
        keyboardType="decimal-pad"
        {...form.field('amount')}
      />
      <TextField label="Date received (YYYY-MM-DD)" required {...form.field('receivedOn')} />
      <TextField
        label="Note (optional)"
        hint="For example who handed it over. Do not put a customer's phone number here."
        {...form.field('note')}
      />
    </FormDialog>
  );
}

/** The cash entries of one order, with a button to record more while something is still due. Changing them needs `finance:adjust`. */
export function CodReceiptsCard({
  orderId,
  orderNumber,
  delivered,
  cash,
}: {
  orderId: string;
  orderNumber: number;
  delivered: boolean;
  cash: OrderCash | undefined;
}) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['finance', 'codReceipts', orderId],
    queryFn: () => api.finance.codReceipts(orderId),
  });
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const reason = useFormState({ reason: '' });
  const canChange = can('finance:adjust');
  const due = cash?.outstandingMinor ?? 0;
  const entries = query.data ?? [];
  if (
    !query.isPending &&
    !query.isError &&
    entries.length === 0 &&
    !(canChange && delivered && due > 0)
  )
    return null;
  const columns: Column<CodReceipt>[] = [
    { key: 'date', header: 'Received', minWidth: 110, render: (r) => r.receivedOn },
    {
      key: 'note',
      header: 'Note',
      flex: 2,
      minWidth: 160,
      render: (r) =>
        r.voidedAt ? `${r.note ?? '—'} (voided: ${r.voidReason ?? ''})` : (r.note ?? '—'),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      minWidth: 110,
      render: (r) => (r.voidedAt ? '—' : formatPrice(r.amountMinor)),
    },
    ...(canChange
      ? [
          {
            key: 'act',
            header: '',
            minWidth: 90,
            render: (r: CodReceipt) =>
              r.voidedAt ? null : (
                <Button size="sm" variant="secondary" onPress={() => setVoiding(r.id)}>
                  Void
                </Button>
              ),
          },
        ]
      : []),
  ];
  return (
    <Section
      title="Cash you collected"
      description="Cash your team received for this order, for example by your own rider. It counts toward what is collected."
      actions={
        canChange && delivered && due > 0 ? (
          <Button variant="secondary" onPress={() => setRecording(true)}>
            Record cash collected
          </Button>
        ) : undefined
      }
    >
      <Stack gap={3}>
        <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading cash entries">
          {entries.length === 0 ? (
            <Text tone="muted">No cash recorded yet.</Text>
          ) : (
            <DataTable
              label="Cash collected entries"
              columns={columns}
              rows={entries}
              rowKey={(r) => r.id}
            />
          )}
        </QueryBoundary>
        {cash && cash.manualCollectedMinor > 0 && (
          <Row justify="between" gap={2}>
            <Text tone="muted">Recorded by your team</Text>
            <Text numeric weight="medium">
              {formatPrice(cash.manualCollectedMinor)}
            </Text>
          </Row>
        )}
      </Stack>
      <RecordCashDialog
        orderId={orderId}
        orderNumber={orderNumber}
        outstandingMinor={due}
        open={recording}
        onClose={() => setRecording(false)}
      />
      {voiding && (
        <FormDialog
          open
          onClose={() => setVoiding(null)}
          title="Void this cash entry"
          submitLabel="Void entry"
          danger
          busy={reason.busy}
          error={reason.formError}
          onSubmit={async () => {
            if (!hasReason(reason.values.reason)) return reason.setErrors({ reason: REASON_ERROR });
            const ok = await reason.run(async () => {
              await api.finance.voidCodReceipt(voiding, reason.values.reason.trim());
              await invalidateFinance(queryClient);
            });
            if (ok) {
              toast.success('Cash entry voided');
              setVoiding(null);
            }
          }}
          size="sm"
        >
          <TextField label="Reason" required autoFocus {...reason.field('reason')} />
        </FormDialog>
      )}
    </Section>
  );
}
