import type { SettlementImportResult } from '@orderloop/contracts';
import {
  Alert,
  Button,
  Link,
  Row,
  Sheet,
  SelectField,
  Stack,
  Text,
  TextField,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { invalidateFinance } from '../../lib/finance';
import { useFormState } from '../../forms/forms';
import { formatPrice } from '../../lib/money';
import { useApi } from '../../core/runtime';

const TEMPLATE =
  'transaction_id,consignment_id,tracking_code,reference,phone,date,type,collected,delivery_charge,cod_fee,return_charge,other_deduction,net,note\n';

function Result({ r }: { r: SettlementImportResult }) {
  const c = r.counts;
  const failed = !!r.fatal || r.errors.length > 0;
  return (
    <Alert
      tone={r.alreadyImported ? 'info' : failed ? 'error' : 'success'}
      title={
        r.alreadyImported
          ? 'This exact file was already imported. Nothing was added.'
          : failed
            ? 'The file has problems. Nothing was recorded.'
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
        {!failed && (
          <>
            <Text>{`${r.rows} line(s): ${c.matched} matched, ${c.unmatched} not matched, ${c.ambiguous} need a person, ${c.unallocated} charge(s) with no parcel, ${c.duplicate} duplicate(s) not counted.`}</Text>
            <Text>{`Cash reported ${formatPrice(r.totals.collectedMinor)} · courier kept ${formatPrice(r.totals.chargesMinor)} · pays out ${formatPrice(r.totals.netMinor)}`}</Text>
            {r.batchId && <Link href={`/cod/${r.batchId}`}>Open this settlement</Link>}
          </>
        )}
      </Stack>
    </Alert>
  );
}

/**
 * Import a courier's statement: provider, reference and the CSV, with "Check file" (a dry run that records nothing) before
 * "Import". Shown in a side sheet from the COD reconciliation page.
 */
export function StatementImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
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
        if (!r.alreadyImported && !r.fatal && !r.errors.length)
          toast.success('Settlement imported');
      }
    } catch (error) {
      setResult(null);
      form.fail(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Import courier statement"
      footer={
        <Row gap={2} wrap>
          <Button variant="secondary" loading={busy === 'check'} onPress={() => run(true)}>
            Check file
          </Button>
          <Button loading={busy === 'import'} onPress={() => run(false)}>
            Import
          </Button>
        </Row>
      }
    >
      <Stack gap={3}>
        <Text tone="muted">
          Paste the CSV. The same file is never imported twice, and no line is recorded twice. Check
          it first to see what would happen.
        </Text>
        {form.formError && (
          <Alert tone="error" title="Import failed">
            {form.formError}
          </Alert>
        )}
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
        {result && <Result r={result} />}
      </Stack>
    </Sheet>
  );
}
