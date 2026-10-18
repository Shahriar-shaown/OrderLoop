import type { Discrepancy } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Link,
  PageHeader,
  Section,
  Stack,
  Text,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DiscrepancyActions } from '../components/SettlementItemActions';
import { FinanceNav } from '../components/FinanceNav';
import { QueryBoundary } from '../components/QueryBoundary';
import { messageFor } from '../errors';
import { DISCREPANCY_LABEL, invalidateFinance } from '../finance';
import { formatPrice } from '../money';
import { useCan } from '../permissions';
import { useApi } from '../runtime';
import { itemColumns } from './SettlementDetailScreen';

export function FinanceIssuesScreen() {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const unmatched = useQuery({
    queryKey: ['finance', 'unmatched'],
    queryFn: () => api.finance.unmatched(),
  });
  const open = useQuery({
    queryKey: ['finance', 'discrepancies', 'open'],
    queryFn: () => api.finance.discrepancies({ status: 'open' }),
  });
  const [busy, setBusy] = useState(false);

  async function recheck() {
    setBusy(true);
    try {
      const r = await api.finance.recheck();
      await invalidateFinance(queryClient);
      toast.success(`Checked ${r.checked}: ${r.opened} opened, ${r.closed} closed`);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  }
  const columns: Column<Discrepancy>[] = [
    {
      key: 'type',
      header: 'Difference',
      minWidth: 170,
      render: (d) => <Badge tone="warning">{DISCREPANCY_LABEL[d.type]}</Badge>,
    },
    {
      key: 'order',
      header: 'Order',
      minWidth: 90,
      render: (d) =>
        d.orderId ? <Link href={`/orders/${d.orderId}`}>{`#${d.orderNumber}`}</Link> : '—',
    },
    { key: 'msg', header: 'What is wrong', flex: 3, minWidth: 260, render: (d) => d.message },
    {
      key: 'exp',
      header: 'Expected',
      align: 'right',
      minWidth: 100,
      render: (d) => (d.expectedMinor === null ? '—' : formatPrice(d.expectedMinor)),
    },
    {
      key: 'act',
      header: 'Reported',
      align: 'right',
      minWidth: 100,
      render: (d) => (d.actualMinor === null ? '—' : formatPrice(d.actualMinor)),
    },
    { key: 'do', header: '', flex: 2, minWidth: 220, render: (d) => <DiscrepancyActions d={d} /> },
  ];
  return (
    <Stack gap={5}>
      <PageHeader
        title="Unmatched lines and discrepancies"
        description="Everything the statements say that your orders do not agree with. Nothing here is hidden by a settlement being imported."
        actions={
          can('finance:import') ? (
            <Button variant="secondary" loading={busy} onPress={recheck}>
              Re-check against orders
            </Button>
          ) : undefined
        }
      />
      <FinanceNav current="/finance/issues" />
      <Section
        title="Statement lines not tied to an order"
        description="Match each to its parcel, or set it aside as not yours."
      >
        <QueryBoundary
          {...unmatched}
          refetch={() => unmatched.refetch()}
          label="Loading unmatched lines"
        >
          {unmatched.data && unmatched.data.length === 0 ? (
            <Alert tone="success">No unmatched lines.</Alert>
          ) : (
            <DataTable
              label="Unmatched lines"
              columns={itemColumns()}
              rows={unmatched.data ?? []}
              rowKey={(i) => i.id}
            />
          )}
        </QueryBoundary>
      </Section>
      <Section
        title="Open discrepancies"
        description="A shortfall stays open until the cash arrives or a person accepts the loss. Delivery never clears one."
      >
        <QueryBoundary {...open} refetch={() => open.refetch()} label="Loading discrepancies">
          {open.data && open.data.length === 0 ? (
            <Text tone="muted">No open discrepancies.</Text>
          ) : (
            <DataTable
              label="Open discrepancies"
              columns={columns}
              rows={open.data ?? []}
              rowKey={(d) => d.id}
            />
          )}
        </QueryBoundary>
      </Section>
    </Stack>
  );
}
