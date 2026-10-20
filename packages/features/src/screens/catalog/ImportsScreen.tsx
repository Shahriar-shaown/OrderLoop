import type { ImportJob, ImportPreview } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Form,
  PageHeader,
  ProgressBar,
  Row,
  Section,
  Split,
  Stack,
  Text,
  TextField,
  useToast,
  type Column,
} from '@orderloop/ui';
import { invalidateCatalog, invalidateKeys } from '../../lib/invalidate';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CsvFilePicker } from '../../forms/CsvFilePicker';
import { ExportButtons } from '../../shell/ExportButtons';
import { FormError } from '../../forms/FormError';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { formatWhen } from '../../lib/format';
import { useFormState } from '../../forms/forms';
import { useIdempotencyKey } from '../../forms/useIdempotencyKey';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { saveTextFile } from '../../lib/saveFile';

const TEMPLATE =
  'product_name,sku,price,category,unit,size,colour,cost,reorder_point,supplier,opening_stock\nCotton tee,TEE-RED-M,850,Clothing,pcs,M,Red,500,5,Dhaka Weavers,20\n';
const TONE = {
  PENDING: 'neutral',
  RUNNING: 'info',
  COMPLETED: 'success',
  FAILED: 'error',
} as const;
const statusLabel = (s: ImportJob['status']) => s.charAt(0) + s.slice(1).toLowerCase();

/** Rows with a problem, as a table (the first rows; the server reports the first 100). */
function ProblemRows({
  errors,
  total,
}: {
  errors: { row: number; message: string }[];
  total: number;
}) {
  const columns: Column<{ row: number; message: string }>[] = [
    {
      key: 'row',
      header: 'Row',
      minWidth: 70,
      flex: 0,
      render: (e) => <Text numeric>{String(e.row)}</Text>,
    },
    { key: 'message', header: 'Problem', flex: 5, minWidth: 240, render: (e) => e.message },
  ];
  return (
    <Stack gap={2}>
      <DataTable
        label="Rows with problems"
        columns={columns}
        rows={errors.slice(0, 50)}
        rowKey={(e) => `${e.row}:${e.message}`}
        rowHeight={44}
        renderCard={(e) => (
          <Text>
            <Text weight="medium">{`Row ${e.row}: `}</Text>
            {e.message}
          </Text>
        )}
      />
      {total > Math.min(errors.length, 50) && (
        <Text
          variant="small"
          tone="muted"
        >{`…and ${total - Math.min(errors.length, 50)} more.`}</Text>
      )}
    </Stack>
  );
}

function JobStatus({ id }: { id: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  // Poll while the worker is still going; stop (and refresh the catalog) once it is done.
  const query = useQuery({
    queryKey: ['import', id],
    queryFn: async () => {
      const job = await api.imports.get(id);
      if (job.status === 'COMPLETED' || job.status === 'FAILED') {
        await Promise.all([
          invalidateKeys(queryClient, ['imports', 'categories']),
          invalidateCatalog(queryClient),
        ]);
      }
      return job;
    },
    refetchInterval: (q) =>
      q.state.data && (q.state.data.status === 'COMPLETED' || q.state.data.status === 'FAILED')
        ? false
        : 1500,
  });
  const job = query.data;
  const done = job?.status === 'COMPLETED' || job?.status === 'FAILED';
  const processed = job ? job.created + job.updated + job.failed : 0;
  const progress = done ? 1 : job?.totalRows ? processed / job.totalRows : 0;
  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Starting the import">
      {job && (
        <Stack gap={3}>
          <Row gap={2} align="center">
            <Badge tone={TONE[job.status]} dot>
              {statusLabel(job.status)}
            </Badge>
            {job.totalRows !== null && (
              <Text variant="small" tone="muted" numeric>
                {`${Math.min(processed, job.totalRows)} of ${job.totalRows} rows`}
              </Text>
            )}
          </Row>
          <ProgressBar value={progress} label="Import progress" />
          {done ? (
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
        <Badge tone="success" dot>{`${preview.willCreate} to create`}</Badge>
        <Badge tone="info" dot>{`${preview.willUpdate} to update`}</Badge>
        <Badge tone={preview.errorCount ? 'error' : 'neutral'} dot>
          {`${preview.errorCount} with problems`}
        </Badge>
      </Row>
      <ProgressBar
        label="Rows that are fine"
        value={preview.totalRows ? preview.validRows / preview.totalRows : 0}
      />
      <Text>
        {preview.totalRows} rows checked. Nothing has been changed yet.
        {preview.errorCount > 0
          ? ' Fix the problems below and check again, or import only the rows that are fine.'
          : ' Every row is fine.'}
      </Text>
      {preview.errors.length > 0 && (
        <ProblemRows errors={preview.errors} total={preview.errorCount} />
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
  const { key: idempotencyKey, renew } = useIdempotencyKey();
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
      const job = await api.imports.products(form.values.csv, idempotencyKey);
      id = job.id;
      await queryClient.invalidateQueries({ queryKey: ['imports'] });
    });
    if (ok) {
      setJobId(id);
      setChecked(null);
      renew(); // the screen stays open: the next import is a new request
      toast.info('Import started');
    }
  }

  const result = (j: ImportJob) => `${j.created} created, ${j.updated} updated, ${j.failed} failed`;
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
      minWidth: 130,
      render: (j) => (
        <Badge tone={TONE[j.status]} dot>
          {statusLabel(j.status)}
        </Badge>
      ),
    },
    { key: 'result', header: 'Result', flex: 3, minWidth: 220, render: result },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Import products"
        description="Add or update many products at once from a CSV. Rows with the same SKU update the existing variant. You see what would happen before anything changes."
        breadcrumbs={[{ label: 'Products & inventory', href: '/products' }, { label: 'Import' }]}
        actions={
          <>
            <Button
              variant="secondary"
              icon="download"
              onPress={() => saveTextFile('orderloop-products-template.csv', TEMPLATE)}
            >
              Download template
            </Button>
            <ExportButtons kinds={['products']} />
          </>
        }
      />
      <Split
        main={
          <>
            <Section
              title="Paste your CSV"
              description="Choose a CSV file or paste its text. An exported catalog file can be edited and imported back."
            >
              <Form onSubmit={check}>
                <FormError message={form.formError} />
                <CsvFilePicker
                  onText={(text) => {
                    form.set('csv', text);
                    setChecked(null);
                  }}
                />
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
          </>
        }
        aside={
          <Card variant="outlined" padding="md">
            <Stack gap={3}>
              <Text variant="title" role="heading" aria-level={2}>
                Columns
              </Text>
              <Stack gap={1}>
                <Text variant="label">Required</Text>
                <Text tone="muted">product_name, sku, price</Text>
              </Stack>
              <Stack gap={1}>
                <Text variant="label">Optional</Text>
                <Text tone="muted">
                  category, unit, variant_name, size, colour, cost, reorder_point, barcode,
                  description, supplier, opening_stock, location
                </Text>
              </Stack>
            </Stack>
          </Card>
        }
      />
      <Section title="Recent imports">
        <QueryBoundary {...history} refetch={() => history.refetch()} label="Loading imports">
          {(history.data ?? []).length === 0 ? (
            <EmptyState icon="upload" title="No imports yet">
              Imports you run appear here with what they created and updated.
            </EmptyState>
          ) : (
            <DataTable
              label="Recent imports"
              columns={columns}
              rows={history.data ?? []}
              rowKey={(j) => j.id}
              renderCard={(j) => (
                <Stack gap={2}>
                  <Row justify="between" gap={2}>
                    <Text weight="medium">{formatWhen(j.createdAt)}</Text>
                    <Badge tone={TONE[j.status]} dot>
                      {statusLabel(j.status)}
                    </Badge>
                  </Row>
                  <Text variant="small" tone="muted">
                    {result(j)}
                  </Text>
                </Stack>
              )}
            />
          )}
        </QueryBoundary>
      </Section>
    </Stack>
  );
}
