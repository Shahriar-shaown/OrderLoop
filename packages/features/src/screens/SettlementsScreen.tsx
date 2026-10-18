import type { SettlementBatch, SettlementImportResult } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Link,
  PageHeader,
  Row,
  Section,
  SelectField,
  Stack,
  Text,
  TextField,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FinanceNav } from '../components/FinanceNav';
import { QueryBoundary } from '../components/QueryBoundary';
import { invalidateFinance, useBatches } from '../finance';
import { formatWhen } from '../format';
import { useFormState } from '../forms';
import { formatPrice } from '../money';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

const TEMPLATE =
  'transaction_id,consignment_id,tracking_code,reference,phone,date,type,collected,delivery_charge,cod_fee,return_charge,other_deduction,net,note\n';
const BATCH_TONE = { reconciled: 'success', ready: 'info', needs_attention: 'warning' } as const;
const BATCH_LABEL = {
  reconciled: 'Reconciled',
  ready: 'Ready to reconcile',
  needs_attention: 'Needs attention',
} as const;

function Result({ r }: { r: SettlementImportResult }) {
  const c = r.counts;
  return (
    <Alert
      tone={r.alreadyImported ? 'info' : r.fatal || r.errors.length ? 'error' : 'success'}
      title={
        r.alreadyImported
          ? 'This exact file was already imported. Nothing was added.'
          : r.dryRun
            ? 'Check only. Nothing was recorded.'
            : 'Imported'
      }
    >
      <Stack gap={1}>
        {r.fatal && <Text>{r.fatal}</Text>}
        {r.errors.map((e) => (
          <Text key={e.line}>{`Line ${e.line}: ${e.message}`}</Text>
        ))}
        {!r.fatal && !r.errors.length && (
          <>
            <Text>{`${r.rows} line(s): ${c.matched} matched, ${c.unmatched} not matched, ${c.ambiguous} need a person, ${c.unallocated} charge(s) with no parcel, ${c.duplicate} duplicate(s) not counted.`}</Text>
            <Text>{`Cash reported ${formatPrice(r.totals.collectedMinor)} · courier kept ${formatPrice(r.totals.chargesMinor)} · pays out ${formatPrice(r.totals.netMinor)}`}</Text>
            {r.batchId && (
              <Link href={`/finance/settlements/${r.batchId}`}>Open this settlement</Link>
            )}
          </>
        )}
      </Stack>
    </Alert>
  );
}

export function SettlementsScreen() {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useBatches();
  const form = useFormState({ provider: 'steadfast', statementRef: '', csv: '' });
  const [result, setResult] = useState<SettlementImportResult | null>(null);
  const [busy, setBusy] = useState<'check' | 'import' | null>(null);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? 'check' : 'import');
    form.clear();
    try {
      const r = await api.finance.importSettlement({
        provider: form.values.provider as 'pathao' | 'steadfast',
        csv: form.values.csv,
        dryRun,
        ...(form.values.statementRef.trim()
          ? { statementRef: form.values.statementRef.trim() }
          : {}),
      });
      setResult(r);
      if (!dryRun) {
        await invalidateFinance(queryClient);
        if (!r.alreadyImported && !r.fatal) toast.success('Settlement imported');
      }
    } catch (error) {
      setResult(null);
      form.fail(error);
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<SettlementBatch>[] = [
    {
      key: 'when',
      header: 'Imported',
      minWidth: 150,
      render: (b) => <Link href={`/finance/settlements/${b.id}`}>{formatWhen(b.createdAt)}</Link>,
    },
    { key: 'courier', header: 'Courier', minWidth: 100, render: (b) => b.provider },
    {
      key: 'ref',
      header: 'Statement',
      minWidth: 120,
      render: (b) => b.statementRef ?? b.fileName ?? '—',
    },
    {
      key: 'lines',
      header: 'Lines',
      align: 'right',
      minWidth: 70,
      render: (b) => String(b.rowCount),
    },
    {
      key: 'issues',
      header: 'Open issues',
      align: 'right',
      minWidth: 110,
      render: (b) => String(b.counts.unmatched + b.counts.ambiguous + b.openDiscrepancies),
    },
    {
      key: 'collected',
      header: 'Cash reported',
      align: 'right',
      minWidth: 120,
      render: (b) => formatPrice(b.totals.collectedMinor),
    },
    {
      key: 'status',
      header: 'Status',
      minWidth: 150,
      render: (b) => <Badge tone={BATCH_TONE[b.status]}>{BATCH_LABEL[b.status]}</Badge>,
    },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Courier settlements"
        description="Import a courier's statement to see which orders were paid, which were not, and where the figures disagree."
      />
      <FinanceNav current="/finance/settlements" />
      {can('finance:import') && (
        <Section
          title="Import a statement"
          description="Paste the CSV. The same file is never imported twice, and no line is recorded twice. Check it first to see what would happen."
        >
          <Stack gap={3}>
            {form.formError && <Alert tone="error">{form.formError}</Alert>}
            <SelectField
              label="Courier"
              value={form.values.provider}
              onChange={(v) => form.set('provider', v)}
              options={[
                { value: 'steadfast', label: 'Steadfast' },
                { value: 'pathao', label: 'Pathao' },
              ]}
            />
            <TextField label="Statement reference (optional)" {...form.field('statementRef')} />
            <TextField
              label="Statement CSV"
              multiline
              numberOfLines={8}
              autoCapitalize="none"
              placeholder={TEMPLATE}
              {...form.field('csv')}
              hint="Columns: transaction_id, consignment_id, tracking_code, reference, phone, date, type, collected, delivery_charge, cod_fee, return_charge, other_deduction, net, note. Amounts in taka."
            />
            <Row gap={2} wrap>
              <Button variant="secondary" loading={busy === 'check'} onPress={() => run(true)}>
                Check file
              </Button>
              <Button loading={busy === 'import'} onPress={() => run(false)}>
                Import
              </Button>
            </Row>
            {result && <Result r={result} />}
          </Stack>
        </Section>
      )}
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading settlements">
        <Section title="Imported settlements">
          {query.data && query.data.length === 0 ? (
            <Text tone="muted">Nothing imported yet.</Text>
          ) : (
            <DataTable
              label="Settlements"
              columns={columns}
              rows={query.data ?? []}
              rowKey={(b) => b.id}
            />
          )}
        </Section>
      </QueryBoundary>
    </Stack>
  );
}
