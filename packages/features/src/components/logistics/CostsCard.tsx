import { MANUAL_COST_KIND_VALUES, type ManualCostKind } from '@orderloop/contracts';
import {
  Button,
  DataTable,
  FormDialog,
  Section,
  SelectField,
  Text,
  TextField,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { COST_LABEL, invalidateFinance } from '../../lib/finance';
import { dayBefore } from '../../lib/format';
import { useFormState } from '../../forms/forms';
import { hasReason, REASON_ERROR } from '../../forms/ReasonDialog';
import { useIdempotencyKey } from '../../forms/useIdempotencyKey';
import { formatPrice, parsePrice } from '../../lib/money';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { QueryBoundary } from '../../shell/QueryBoundary';

function AddCost({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({ kind: 'packaging', amount: '', incurredOn: dayBefore(0), note: '' });
  const { key, renew } = useIdempotencyKey();
  if (!open) return null;
  async function submit() {
    const amount = parsePrice(form.values.amount);
    if (amount === null || amount <= 0)
      return form.setErrors({ amount: 'Enter an amount in taka, like 450 or 450.50' });
    const ok = await form.run(async () => {
      await api.finance.createCost({
        kind: form.values.kind as ManualCostKind,
        amountMinor: amount,
        incurredOn: form.values.incurredOn,
        note: form.values.note.trim(),
        idempotencyKey: key,
      });
      await invalidateFinance(queryClient);
    });
    if (ok) {
      renew();
      toast.success('Cost recorded');
      onClose();
    }
  }
  return (
    <FormDialog
      open
      onClose={onClose}
      title="Record a cost"
      onSubmit={submit}
      submitLabel="Record cost"
      busy={form.busy}
      error={form.formError}
    >
      <SelectField
        label="What kind of cost"
        value={form.values.kind}
        onChange={(v) => form.set('kind', v)}
        // Courier charges come from the statements; only the costs a seller records themselves are offered.
        options={MANUAL_COST_KIND_VALUES.map((k) => ({ value: k, label: COST_LABEL[k] }))}
      />
      <TextField label="Amount (৳)" required keyboardType="decimal-pad" {...form.field('amount')} />
      <TextField label="Date (YYYY-MM-DD)" required {...form.field('incurredOn')} />
      <TextField label="What it was for" required {...form.field('note')} />
      <Text variant="caption" tone="muted">
        Courier charges come from statements, not from here. Do not enter them twice.
      </Text>
    </FormDialog>
  );
}

/** The costs the seller recorded by hand in a period: list, record a new one, void with a reason. Needs `finance:adjust` to change. */
export function CostsCard({ from, to }: { from: string; to: string }) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['finance', 'costs', from, to],
    queryFn: () => api.finance.costs({ from, to }),
  });
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const reason = useFormState({ reason: '' });
  const columns: Column<NonNullable<typeof query.data>[number]>[] = [
    { key: 'date', header: 'Date', minWidth: 110, render: (c) => c.incurredOn },
    { key: 'kind', header: 'Kind', minWidth: 130, render: (c) => COST_LABEL[c.kind] },
    {
      key: 'note',
      header: 'What for',
      flex: 2,
      minWidth: 180,
      render: (c) => (c.voidedAt ? `${c.note} (voided: ${c.voidReason})` : c.note),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      minWidth: 110,
      render: (c) => (c.voidedAt ? '—' : formatPrice(c.amountMinor)),
    },
    ...(can('finance:adjust')
      ? [
          {
            key: 'act',
            header: '',
            minWidth: 90,
            render: (c: NonNullable<typeof query.data>[number]) =>
              c.voidedAt ? null : (
                <Button size="sm" variant="secondary" onPress={() => setVoiding(c.id)}>
                  Void
                </Button>
              ),
          },
        ]
      : []),
  ];
  return (
    <Section
      title="Costs you recorded"
      description="Packaging, advertising and other costs. Courier charges come from statements."
      actions={
        can('finance:adjust') ? (
          <Button variant="secondary" onPress={() => setAdding(true)}>
            Record a cost
          </Button>
        ) : undefined
      }
    >
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading costs">
        {query.data && query.data.length === 0 ? (
          <Text tone="muted">No costs recorded for this period.</Text>
        ) : (
          <DataTable
            label="Recorded costs"
            columns={columns}
            rows={query.data ?? []}
            rowKey={(c) => c.id}
          />
        )}
      </QueryBoundary>
      <AddCost open={adding} onClose={() => setAdding(false)} />
      {voiding && (
        <FormDialog
          open
          onClose={() => setVoiding(null)}
          title="Void this cost"
          submitLabel="Void cost"
          danger
          busy={reason.busy}
          error={reason.formError}
          onSubmit={async () => {
            if (!hasReason(reason.values.reason)) return reason.setErrors({ reason: REASON_ERROR });
            const ok = await reason.run(async () => {
              await api.finance.voidCost(voiding, reason.values.reason.trim());
              await invalidateFinance(queryClient);
            });
            if (ok) {
              toast.success('Cost voided');
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
