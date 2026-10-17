import type { ImportJob } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Form,
  PageHeader,
  Section,
  Stack,
  Text,
  TextField,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormError } from '../components/FormError';
import { QueryBoundary } from '../components/QueryBoundary';
import { formatWhen } from '../format';
import { useFormState } from '../forms';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

const TEMPLATE =
  'product_name,sku,price,category,unit,variant_name,cost,reorder_point,opening_stock\nCotton tee,TEE-RED-M,850,Clothing,pcs,Red / M,500,5,20\n';
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

export function ImportsScreen() {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({ csv: '' });
  const [jobId, setJobId] = useState<string | null>(null);
  const history = useQuery({ queryKey: ['imports'], queryFn: () => api.imports.list() });

  if (!can('catalog:write'))
    return <Alert tone="warning">Your role can view the catalog but not import into it.</Alert>;

  async function submit() {
    if (!form.values.csv.trim()) return form.setErrors({ csv: 'Paste your CSV first' });
    let id = '';
    const ok = await form.run(async () => {
      const job = await api.imports.products(form.values.csv);
      id = job.id;
      await queryClient.invalidateQueries({ queryKey: ['imports'] });
    });
    if (ok) {
      setJobId(id);
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
        description="Add or update many products at once from a CSV. Rows with the same SKU update the existing variant."
      />
      <Section
        title="Paste your CSV"
        description="Required columns: product_name, sku, price. Optional: category, unit, variant_name, cost, reorder_point, barcode, description, opening_stock, location."
      >
        <Form onSubmit={submit}>
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
            <Button type="submit" loading={form.busy}>
              Start import
            </Button>
            <Button variant="secondary" onPress={() => form.set('csv', TEMPLATE)}>
              Use the example
            </Button>
          </Stack>
        </Form>
      </Section>
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
