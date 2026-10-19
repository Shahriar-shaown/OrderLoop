import type { Discrepancy, SettlementBatchDetail } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Grid,
  KeyValueList,
  Link,
  PageHeader,
  Row,
  Split,
  Stack,
  StatCard,
  Text,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { QueryBoundary } from '../components/QueryBoundary';
import { DiscrepancyActions } from '../components/SettlementItemActions';
import { StatementLineCard, statementLineColumns } from '../components/StatementLines';
import { COURIER_NAME } from '../couriers';
import { messageFor } from '../errors';
import {
  BATCH_LABEL,
  BATCH_TONE,
  DISCREPANCY_LABEL,
  invalidateFinance,
  useBatch,
} from '../finance';
import { formatDayTime, formatWhen } from '../format';
import { formatPrice } from '../money';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

/** Open discrepancies about this statement's lines, each once (a parcel's total can be shared by several lines). */
const openDiscrepancies = (b: SettlementBatchDetail): Discrepancy[] => {
  const seen = new Map<string, Discrepancy>();
  for (const item of b.items)
    for (const d of item.discrepancies) if (d.status === 'open') seen.set(d.id, d);
  return [...seen.values()];
};

function DiscrepancyBlock({ d }: { d: Discrepancy }) {
  const short =
    d.expectedMinor !== null && d.actualMinor !== null ? d.actualMinor - d.expectedMinor : null;
  return (
    <Card variant="outlined" padding="sm">
      <Stack gap={2}>
        <Row gap={2} wrap align="center">
          <Badge tone="error" dot>
            {DISCREPANCY_LABEL[d.type]}
          </Badge>
          {d.orderId && <Link href={`/orders/${d.orderId}`}>{`#${d.orderNumber}`}</Link>}
        </Row>
        <Text variant="small">{d.message}</Text>
        {short !== null && (
          <Text variant="caption" tone="muted" numeric>
            {`Expected ${formatPrice(d.expectedMinor ?? 0)} · reported ${formatPrice(d.actualMinor ?? 0)} · ${short < 0 ? 'short' : 'over'} by ${formatPrice(Math.abs(short))}`}
          </Text>
        )}
        <DiscrepancyActions d={d} />
      </Stack>
    </Card>
  );
}

/** One statement: its figures, what stops it being reconciled, how the difference is worked out, and every line. */
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
      {b && <Detail b={b} busy={busy} onReconcile={reconcile} canImport={can('finance:import')} />}
    </QueryBoundary>
  );
}

function Detail({
  b,
  busy,
  onReconcile,
  canImport,
}: {
  b: SettlementBatchDetail;
  busy: boolean;
  onReconcile: () => void;
  canImport: boolean;
}) {
  const name = b.statementRef ?? b.fileName ?? COURIER_NAME[b.provider];
  const discrepancies = openDiscrepancies(b);
  const reportedForCovered = b.expectedMinor + b.differenceMinor;
  const toDecide = b.counts.unmatched + b.counts.ambiguous;
  return (
    <Stack gap={5}>
      <PageHeader
        title={`Settlement ${name}`}
        breadcrumbs={[{ label: 'COD reconciliation', href: '/cod' }, { label: name }]}
        description={`${COURIER_NAME[b.provider]} · imported ${formatWhen(b.createdAt)}${b.createdByName ? ` by ${b.createdByName}` : ''}${b.reconciledAt ? ` · reconciled ${formatWhen(b.reconciledAt)}` : ''}`}
        badges={
          <Badge tone={BATCH_TONE[b.status]} dot>
            {BATCH_LABEL[b.status]}
          </Badge>
        }
        actions={
          canImport && b.status !== 'reconciled' ? (
            <Button disabled={!b.canReconcile} loading={busy} onPress={onReconcile}>
              Mark reconciled
            </Button>
          ) : undefined
        }
      />

      <Grid columns={{ mobile: 2, tablet: 3, desktop: 5 }}>
        <StatCard
          label="Expected"
          value={formatPrice(b.expectedMinor)}
          hint="COD of the orders these lines cover"
        />
        <StatCard
          label="Reported"
          value={formatPrice(b.totals.collectedMinor)}
          hint="By the courier, in counted lines"
        />
        <StatCard
          label="Courier charges"
          value={formatPrice(b.totals.chargesMinor)}
          hint="Delivery, COD fee, returns, other"
        />
        <StatCard
          label="Paid out"
          value={formatPrice(b.totals.netMinor)}
          hint="Reported less charges"
        />
        <StatCard
          label="Lines"
          value={String(b.rowCount)}
          hint={`${b.counts.matched} matched · ${toDecide} to decide · ${b.counts.duplicate} duplicate`}
          tone={toDecide > 0 ? 'warning' : 'default'}
        />
      </Grid>

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
          <Text>Reconciling records that you have checked this statement against your orders.</Text>
        </Alert>
      ) : null}

      <Split
        main={
          <Stack gap={3}>
            <Row gap={2} align="center" wrap>
              <Text variant="title" role="heading" aria-level={2}>
                Review discrepancy
              </Text>
              {discrepancies.length > 0 && (
                <Badge tone="error" dot>{`Open · ${discrepancies.length}`}</Badge>
              )}
            </Row>
            {discrepancies.length === 0 ? (
              <EmptyState icon="check-circle" title="No open discrepancies">
                What this courier reported agrees with your orders for every matched line.
              </EmptyState>
            ) : (
              discrepancies.map((d) => <DiscrepancyBlock key={d.id} d={d} />)
            )}
          </Stack>
        }
        aside={
          <Card padding="md">
            <Stack gap={3}>
              <Text variant="fine" tone="muted">
                HOW THE DIFFERENCE IS CALCULATED
              </Text>
              <KeyValueList
                layout="inline"
                items={[
                  { label: 'Expected COD of covered orders', value: formatPrice(b.expectedMinor) },
                  { label: 'Reported for those orders', value: formatPrice(reportedForCovered) },
                  {
                    label: b.differenceMinor < 0 ? 'Short by' : 'Difference',
                    value: formatPrice(b.differenceMinor),
                    emphasis: true,
                    tone: b.differenceMinor < 0 ? 'danger' : 'default',
                  },
                ]}
              />
              <Text variant="caption" tone="muted">
                {`Courier charges (${formatPrice(b.totals.chargesMinor)}) reduce what the courier pays out, not the COD owed, so they are not part of the difference. Imported ${formatDayTime(b.createdAt)}.`}
              </Text>
            </Stack>
          </Card>
        }
      />

      <Stack gap={3}>
        <Text variant="title" role="heading" aria-level={2}>
          Statement lines
        </Text>
        <DataTable
          label="Statement lines"
          columns={statementLineColumns()}
          rows={b.items}
          rowKey={(i) => i.id}
          renderCard={(i) => <StatementLineCard item={i} />}
          empty={<EmptyState icon="file" title="This statement has no lines" />}
        />
        <Text variant="caption" tone="muted">
          Every line as imported. Duplicates are kept for the record and never counted.
        </Text>
      </Stack>
    </Stack>
  );
}
