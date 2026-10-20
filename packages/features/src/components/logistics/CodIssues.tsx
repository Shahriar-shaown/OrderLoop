import type { Discrepancy } from '@orderloop/contracts';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Link,
  Row,
  Section,
  Stack,
  Text,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { messageFor } from '../../forms/errors';
import {
  DISCREPANCY_LABEL,
  invalidateFinance,
  useOpenDiscrepancies,
  useUnmatched,
} from '../../lib/finance';
import { formatPrice } from '../../lib/money';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { DiscrepancyActions } from './SettlementItemActions';
import { StatementLineCard, statementLineColumns } from './StatementLines';

const discrepancyColumns: Column<Discrepancy>[] = [
  {
    key: 'type',
    header: 'Difference',
    minWidth: 170,
    render: (d) => (
      <Badge tone="error" dot>
        {DISCREPANCY_LABEL[d.type]}
      </Badge>
    ),
  },
  {
    key: 'order',
    header: 'Order',
    minWidth: 90,
    render: (d) =>
      d.orderId ? <Link href={`/orders/${d.orderId}`}>{`#${d.orderNumber}`}</Link> : '—',
  },
  {
    key: 'msg',
    header: 'What is wrong',
    flex: 3,
    minWidth: 240,
    show: 'wide',
    render: (d) => d.message,
  },
  {
    key: 'exp',
    header: 'Expected',
    align: 'right',
    minWidth: 100,
    show: 'desktop',
    render: (d) => (d.expectedMinor === null ? '—' : formatPrice(d.expectedMinor)),
  },
  {
    key: 'act',
    header: 'Reported',
    align: 'right',
    minWidth: 100,
    show: 'desktop',
    render: (d) => (d.actualMinor === null ? '—' : formatPrice(d.actualMinor)),
  },
  { key: 'do', header: '', flex: 2, minWidth: 220, render: (d) => <DiscrepancyActions d={d} /> },
];

const discrepancyCard = (d: Discrepancy) => (
  <Stack gap={2}>
    <Row gap={2} wrap align="center">
      <Badge tone="error" dot>
        {DISCREPANCY_LABEL[d.type]}
      </Badge>
      {d.orderId && <Link href={`/orders/${d.orderId}`}>{`#${d.orderNumber}`}</Link>}
    </Row>
    <Text variant="small">{d.message}</Text>
    <DiscrepancyActions d={d} />
  </Stack>
);

/** Statement lines no order claims, and open differences between statements and orders: each with its next action. */
export function CodIssues() {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const unmatched = useUnmatched();
  const open = useOpenDiscrepancies();
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

  return (
    <Section
      title="Unmatched lines & discrepancies"
      description="Everything the statements say that your orders do not agree with. A shortfall stays open until the cash arrives or a person accepts the loss."
      actions={
        can('finance:import') ? (
          <Button variant="secondary" size="sm" loading={busy} onPress={recheck}>
            Re-check against orders
          </Button>
        ) : undefined
      }
    >
      <Stack gap={5}>
        <Stack gap={2}>
          <Text variant="heading">Statement lines not tied to an order</Text>
          <QueryBoundary
            {...unmatched}
            refetch={() => unmatched.refetch()}
            label="Loading unmatched lines"
          >
            <DataTable
              label="Unmatched lines"
              columns={statementLineColumns()}
              rows={unmatched.data ?? []}
              rowKey={(i) => i.id}
              renderCard={(i) => <StatementLineCard item={i} />}
              empty={
                <EmptyState icon="check-circle" title="No unmatched lines">
                  Every statement line is tied to an order or set aside.
                </EmptyState>
              }
            />
          </QueryBoundary>
        </Stack>
        <Stack gap={2}>
          <Text variant="heading">Open discrepancies</Text>
          <QueryBoundary {...open} refetch={() => open.refetch()} label="Loading discrepancies">
            <DataTable
              label="Open discrepancies"
              columns={discrepancyColumns}
              rows={open.data ?? []}
              rowKey={(d) => d.id}
              renderCard={discrepancyCard}
              empty={
                <EmptyState icon="check-circle" title="No open discrepancies">
                  What couriers reported agrees with your orders.
                </EmptyState>
              }
            />
          </QueryBoundary>
        </Stack>
      </Stack>
    </Section>
  );
}
