import { COST_KIND_VALUES, type CostKind, type FinanceFigure } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  FormDialog,
  PageHeader,
  Row,
  Section,
  SelectField,
  Stack,
  Tabs,
  Text,
  TextField,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FinanceNav } from '../components/FinanceNav';
import { QueryBoundary } from '../components/QueryBoundary';
import {
  COST_LABEL,
  dayOffset,
  GROUP_LABEL,
  invalidateFinance,
  SOURCE_LABEL,
  useFinanceSummary,
} from '../finance';
import { useFormState } from '../forms';
import { newIdempotencyKey } from '../hooks';
import { formatPrice, parsePrice } from '../money';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

const PERIODS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];
const GROUPS = ['sales', 'revenue', 'cash', 'outstanding', 'expenses', 'profit'] as const;
const GROUP_HELP: Record<(typeof GROUPS)[number], string> = {
  sales: 'Orders placed. Not money received and not revenue.',
  revenue: 'What you earned from goods delivered. Delivered is not the same as paid.',
  cash: 'What courier statements say was collected. Not proof it reached your bank.',
  outstanding: 'COD couriers still owe you for delivered orders.',
  expenses: 'What it cost you, each from its own source.',
  profit: 'An estimate that follows your records.',
};

function Figure({ f }: { f: FinanceFigure }) {
  return (
    <Stack gap={1}>
      <Row gap={2} justify="between" wrap align="center">
        <Text weight="medium">{f.label}</Text>
        <Text weight="bold">{formatPrice(f.amountMinor)}</Text>
      </Row>
      <Row gap={2} wrap align="center">
        <Badge tone="neutral">{SOURCE_LABEL[f.source] ?? f.source}</Badge>
        <Text variant="caption" tone="muted">
          {f.note}
        </Text>
      </Row>
    </Stack>
  );
}

function AddCost({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({ kind: 'packaging', amount: '', incurredOn: dayOffset(0), note: '' });
  const [key, setKey] = useState(newIdempotencyKey);
  if (!open) return null;
  async function submit() {
    const amount = parsePrice(form.values.amount);
    if (amount === null || amount <= 0)
      return form.setErrors({ amount: 'Enter an amount in taka, like 450 or 450.50' });
    const ok = await form.run(async () => {
      await api.finance.createCost({
        kind: form.values.kind as CostKind,
        amountMinor: amount,
        incurredOn: form.values.incurredOn,
        note: form.values.note.trim(),
        idempotencyKey: key,
      });
      await invalidateFinance(queryClient);
    });
    if (ok) {
      setKey(newIdempotencyKey());
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
        options={COST_KIND_VALUES.map((k) => ({ value: k, label: COST_LABEL[k] }))}
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

function Costs({ from, to }: { from: string; to: string }) {
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
            if (reason.values.reason.trim().length < 3)
              return reason.setErrors({ reason: 'Say why (at least 3 characters)' });
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

export function FinanceScreen() {
  const [period, setPeriod] = useState('30');
  const to = dayOffset(0);
  const from = dayOffset(Number(period) - 1);
  const query = useFinanceSummary(from, to);
  const s = query.data;
  return (
    <Stack gap={5}>
      <PageHeader
        title="Finance"
        description="Sales, revenue, cash, outstanding COD, expenses and estimated profit. Each is a different thing and each says where it comes from."
      />
      <FinanceNav current="/finance" />
      <Tabs items={PERIODS} value={period} onChange={setPeriod} label="Period" />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading finance figures">
        {s && (
          <Stack gap={5}>
            <Text tone="muted">{`${s.from} to ${s.to} (${s.timezone})`}</Text>
            {s.estimatedProfitMinor === null && s.profitWithheldReason && (
              <Alert tone="warning" title="Profit cannot be worked out yet">
                {s.profitWithheldReason}
              </Alert>
            )}
            {GROUPS.map((g) => {
              const figures = s.figures.filter((f) => f.group === g);
              if (!figures.length) return null;
              return (
                <Section key={g} title={GROUP_LABEL[g] ?? g} description={GROUP_HELP[g]}>
                  <Stack gap={4}>
                    {figures.map((f) => (
                      <Figure key={f.key} f={f} />
                    ))}
                  </Stack>
                </Section>
              );
            })}
            <Section title="Read this before you trust the figures">
              <Stack gap={2}>
                {s.caveats.map((c) => (
                  <Text key={c} tone="muted">
                    {c}
                  </Text>
                ))}
              </Stack>
            </Section>
          </Stack>
        )}
      </QueryBoundary>
      <Costs from={from} to={to} />
    </Stack>
  );
}
