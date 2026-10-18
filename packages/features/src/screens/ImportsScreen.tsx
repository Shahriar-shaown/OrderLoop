import type { ImportJob, ImportPreview } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Form,
  PageHeader,
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
import { ExportButtons } from '../components/ExportButtons';
import { FormError } from '../components/FormError';
import { QueryBoundary } from '../components/QueryBoundary';
import { formatWhen } from '../format';
import { useFormState } from '../forms';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

const TEMPLATE =
  'product_name,sku,price,category,unit,size,colour,cost,reorder_point,supplier,opening_stock\nCotton tee,TEE-RED-M,850,Clothing,pcs,M,Red,500,5,Dhaka Weavers,20\n';
const TONE = {
  PENDING: 'neutral',
  RUNNING: 'info',
  COMPLETED: 'success',
  FAILED: 'error',
} as const;

function JobStatus({ id }: { id: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  // Poll while the worker is still going; stop (and refresh the catalog) once it is done.
  const query = useQuery({
    queryKey: ['import', id],
    queryFn: async () => {
      const job = await api.imports.get(id);
      if (job.status === 'COMPLETED' || job.status === 'FAILED') {
        await Promise.all(
          ['products', 'imports', 'inventory', 'categories'].map((k) =>
            queryClient.invalidateQueries({ queryKey: [k] }),
          ),
        );
      }
      return job;
    },
    refetchInterval: (q) =>
      q.state.data && (q.state.data.status === 'COMPLETED' || q.state.data.status === 'FAILED')
        ? false
        : 1500,
  });
  const job = query.data;
  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Starting the import">
      {job && (
        <Stack gap={3}>
          <Badge tone={TONE[job.status]}>{job.status.toLowerCase()}</Badge>
          {job.status === 'COMPLETED' || job.status === 'FAILED' ? (
            <Text>
              {job.created} created, {job.updated} updated, {job.failed} failed
              {job.totalRows !== null ? ` of ${job.totalRows} rows` : ''}.
            </Text>
          ) : (
            <Text tone="muted">Importing in the background. This page updates by itself.</Text>
          )}
          {job.errors.length > 0 && (
            <Alert tone="warning" title="Some rows were skipped">
              <Stack gap={1}>
                {job.errors.slice(0, 20).map((e) => (
                  <Text key={`${e.row}:${e.message}`}>
                    Row {e.row}: {e.message}
                  </Text>
                ))}
              </Stack>
            </Alert>
          )}
        </Stack>
      )}
    </QueryBoundary>
  );
}

function Preview({ preview }: { preview: ImportPreview }) {
  if (preview.fatal)
    return (
      <Alert tone="error" title="This file cannot be imported">
        {preview.fatal}
      </Alert>
    );
  return (
    <Stack gap={3}>
      <Row gap={2} wrap>
        <Badge tone="success">{`${preview.willCreate} to create`}</Badge>
        <Badge tone="info">{`${preview.willUpdate} to update`}</Badge>
        <Badge tone={preview.errorCount ? 'error' : 'neutral'}>
          {`${preview.errorCount} with problems`}
        </Badge>
      </Row>
      <Text>
        {preview.totalRows} rows checked. Nothing has been changed yet.
        {preview.errorCount > 0
          ? ' Fix the problems below and check again, or import only the rows that are fine.'
          : ' Every row is fine.'}
      </Text>
      {preview.errors.length > 0 && (
        <Alert tone="warning" title="Rows that would be skipped">
          <Stack gap={1}>
            {preview.errors.slice(0, 20).map((e) => (
              <Text key={`${e.row}:${e.message}`}>
                Row {e.row}: {e.message}
              </Text>
            ))}
            {preview.errorCount > 20 && <Text>…and {preview.errorCount - 20} more.</Text>}
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}

export function ImportsScreen() {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({ csv: '' });
  const [jobId, setJobId] = useState<string | null>(null);
  // The check belongs to the exact text it was run on: edit the text and it no longer counts.
  const [checked, setChecked] = useState<{ csv: string; preview: ImportPreview } | null>(null);
  const history = useQuery({ queryKey: ['imports'], queryFn: () => api.imports.list() });

  if (!can('catalog:write'))
    return <Alert tone="warning">Your role can view the catalog but not import into it.</Alert>;

  const current = checked && checked.csv === form.values.csv ? checked.preview : null;

  async function check() {
    if (!form.values.csv.trim()) return form.setErrors({ csv: 'Paste your CSV first' });
    const csv = form.values.csv;
    let preview: ImportPreview | null = null;
    const ok = await form.run(async () => {
      preview = await api.imports.validateProducts(csv);
    });
    if (ok && preview) setChecked({ csv, preview });
  }

  async function start() {
    if (!current || current.fatal || current.validRows === 0) return;
    let id = '';
    const ok = await form.run(async () => {
      const job = await api.imports.products(form.values.csv);
      id = job.id;
      await queryClient.invalidateQueries({ queryKey: ['imports'] });
    });
    if (ok) {
      setJobId(id);
      setChecked(null);
      toast.info('Import started');
    }
  }

  const columns: Column<ImportJob>[] = [
    {
      key: 'when',
      header: 'Started',
      flex: 2,
      minWidth: 170,
      render: (j) => formatWhen(j.createdAt),
    },
    {
      key: 'status',
      header: 'Status',
      minWidth: 120,
      render: (j) => <Badge tone={TONE[j.status]}>{j.status.toLowerCase()}</Badge>,
    },
    {
      key: 'result',
      header: 'Result',
      flex: 3,
      minWidth: 220,
      render: (j) => `${j.created} created, ${j.updated} updated, ${j.failed} failed`,
    },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Import products"
        description="Add or update many products at once from a CSV. Rows with the same SKU update the existing variant. You see what would happen before anything changes."
        actions={<ExportButtons kinds={['products']} />}
      />
      <Section
        title="Paste your CSV"
        description="Required columns: product_name, sku, price. Optional: category, unit, variant_name, size, colour, cost, reorder_point, barcode, description, supplier, opening_stock, location. An exported catalog file can be edited and imported back."
      >
        <Form onSubmit={check}>
          <FormError message={form.formError} />
          <TextField
            label="CSV"
            multiline
            numberOfLines={8}
            placeholder={TEMPLATE}
            autoCapitalize="none"
            autoCorrect={false}
            {...form.field('csv')}
          />
          <Stack direction="row" gap={2} wrap>
            <Button type="submit" loading={form.busy && !current}>
              Check file
            </Button>
            <Button variant="secondary" onPress={() => form.set('csv', TEMPLATE)}>
              Use the example
            </Button>
          </Stack>
        </Form>
      </Section>
      {current && (
        <Section title="Check result">
          <Preview preview={current} />
          {!current.fatal && current.validRows > 0 && (
            <Stack align="start">
              <Button loading={form.busy} onPress={start}>
                {current.errorCount > 0
                  ? `Import ${current.validRows} fine rows, skip ${current.errorCount}`
                  : `Import ${current.validRows} rows`}
              </Button>
            </Stack>
          )}
        </Section>
      )}
      {jobId && (
        <Section title="This import">
          <JobStatus id={jobId} />
        </Section>
      )}
      <Section title="Recent imports">
        <QueryBoundary {...history} refetch={() => history.refetch()} label="Loading imports">
          {(history.data ?? []).length === 0 ? (
            <Text tone="muted">No imports yet.</Text>
          ) : (
            <DataTable
              label="Recent imports"
              columns={columns}
              rows={history.data ?? []}
              rowKey={(j) => j.id}
            />
          )}
        </QueryBoundary>
      </Section>
    </Stack>
  );
}
