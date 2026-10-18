import type { SettlementItem } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Link,
  PageHeader,
  Row,
  Section,
  Stack,
  StatCard,
  Text,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DiscrepancyActions, SettlementItemActions } from '../components/SettlementItemActions';
import { FinanceNav } from '../components/FinanceNav';
import { QueryBoundary } from '../components/QueryBoundary';
import { messageFor } from '../errors';
import {
  DISCREPANCY_LABEL,
  invalidateFinance,
  MATCH_LABEL,
  MATCH_TONE,
  useBatch,
} from '../finance';
import { formatWhen } from '../format';
import { formatPrice } from '../money';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

export const itemColumns = (): Column<SettlementItem>[] => [
  { key: 'line', header: 'Line', minWidth: 60, render: (i) => String(i.lineNo) },
  { key: 'date', header: 'Date', minWidth: 105, render: (i) => i.date },
  {
    key: 'ids',
    header: 'Identifiers',
    flex: 2,
    minWidth: 170,
    render: (i) => (
      <Stack gap={1}>
        {[
          i.consignmentId && `Consignment ${i.consignmentId}`,
          i.trackingCode && `Tracking ${i.trackingCode}`,
          i.reference && `Ref ${i.reference}`,
        ]
          .filter(Boolean)
          .map((t) => (
            <Text key={String(t)} variant="caption">
              {String(t)}
            </Text>
          ))}
        {!i.consignmentId && !i.trackingCode && !i.reference && (
          <Text variant="caption" tone="muted">
            none
          </Text>
        )}
      </Stack>
    ),
  },
  {
    key: 'order',
    header: 'Order',
    minWidth: 90,
    render: (i) =>
      i.orderId ? <Link href={`/orders/${i.orderId}`}>{`#${i.orderNumber}`}</Link> : '—',
  },
  {
    key: 'status',
    header: 'Match',
    flex: 2,
    minWidth: 190,
    render: (i) => (
      <Stack gap={1}>
        <Badge tone={MATCH_TONE[i.matchStatus]}>{MATCH_LABEL[i.matchStatus]}</Badge>
        {i.matchNote && (
          <Text variant="caption" tone="muted">
            {i.matchNote}
          </Text>
        )}
      </Stack>
    ),
  },
  {
    key: 'collected',
    header: 'Collected',
    align: 'right',
    minWidth: 110,
    render: (i) => formatPrice(i.collectedMinor),
  },
  {
    key: 'charges',
    header: 'Courier kept',
    align: 'right',
    minWidth: 110,
    render: (i) =>
      formatPrice(
        i.deliveryChargeMinor + i.codFeeMinor + i.returnChargeMinor + i.otherDeductionMinor,
      ),
  },
  {
    key: 'net',
    header: 'Pays out',
    align: 'right',
    minWidth: 110,
    render: (i) => formatPrice(i.netMinor),
  },
  {
    key: 'disc',
    header: 'Discrepancies',
    flex: 2,
    minWidth: 200,
    render: (i) => (
      <Stack gap={1}>
        {i.discrepancies.map((d) => (
          <Stack key={d.id} gap={1}>
            <Badge tone="warning">{DISCREPANCY_LABEL[d.type]}</Badge>
            <Text variant="caption">{d.message}</Text>
            <DiscrepancyActions d={d} />
          </Stack>
        ))}
      </Stack>
    ),
  },
  {
    key: 'act',
    header: '',
    flex: 2,
    minWidth: 220,
    render: (i) => <SettlementItemActions item={i} />,
  },
];

export function SettlementDetailScreen({ id }: { id: string }) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useBatch(id);
  const [busy, setBusy] = useState(false);
  const b = query.data;

  async function reconcile() {
    setBusy(true);
    try {
      await api.finance.reconcile(id);
      await invalidateFinance(queryClient);
      toast.success('Settlement reconciled');
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading settlement">
      {b && (
        <Stack gap={5}>
          <PageHeader
            title={`Settlement: ${b.statementRef ?? b.fileName ?? b.provider}`}
            description={`${b.provider} · imported ${formatWhen(b.createdAt)}${b.createdByName ? ` by ${b.createdByName}` : ''}`}
            actions={
              <Button href="/finance/settlements" variant="secondary">
                All settlements
              </Button>
            }
          />
          <FinanceNav current="/finance/settlements" />
          <Row gap={2} wrap align="center">
            <Badge
              tone={
                b.status === 'reconciled' ? 'success' : b.status === 'ready' ? 'info' : 'warning'
              }
            >
              {b.status === 'reconciled'
                ? 'Reconciled'
                : b.status === 'ready'
                  ? 'Ready to reconcile'
                  : 'Needs attention'}
            </Badge>
            {b.reconciledAt && (
              <Text
                variant="caption"
                tone="muted"
              >{`Reconciled ${formatWhen(b.reconciledAt)}`}</Text>
            )}
          </Row>
          <Row gap={3} wrap>
            <StatCard
              label="Cash reported"
              value={formatPrice(b.totals.collectedMinor)}
              hint="By the courier, in counted lines"
            />
            <StatCard
              label="Courier kept"
              value={formatPrice(b.totals.chargesMinor)}
              hint="Delivery, COD fee, returns, other"
            />
            <StatCard
              label="Pays out"
              value={formatPrice(b.totals.netMinor)}
              hint="Cash reported less charges"
            />
            <StatCard
              label="Lines"
              value={String(b.rowCount)}
              hint={`${b.counts.matched} matched · ${b.counts.unmatched + b.counts.ambiguous} to decide · ${b.counts.duplicate} duplicate`}
            />
          </Row>
          {b.issues.length > 0 ? (
            <Alert tone="warning" title="This settlement cannot be reconciled yet">
              <Stack gap={1}>
                {b.issues.map((i) => (
                  <Text key={i}>{i}</Text>
                ))}
              </Stack>
            </Alert>
          ) : b.status !== 'reconciled' ? (
            <Alert tone="success" title="Nothing is unmatched or in doubt">
              <Text>
                Reconciling records that you have checked this statement against your orders.
              </Text>
            </Alert>
          ) : null}
          {can('finance:import') && b.status !== 'reconciled' && (
            <Row>
              <Button disabled={!b.canReconcile} loading={busy} onPress={reconcile}>
                Mark reconciled
              </Button>
            </Row>
          )}
          <Section
            title="Statement lines"
            description="Every line as imported. Duplicates are kept for the record and never counted."
          >
            <DataTable
              label="Statement lines"
              columns={itemColumns()}
              rows={b.items}
              rowKey={(i) => i.id}
            />
          </Section>
        </Stack>
      )}
    </QueryBoundary>
  );
}
