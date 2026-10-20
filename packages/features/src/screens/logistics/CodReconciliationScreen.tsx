import type { Discrepancy, SettlementBatch } from '@orderloop/contracts';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  FilterMenu,
  Grid,
  Link,
  PageHeader,
  ProgressBar,
  Row,
  Stack,
  StatCard,
  Tabs,
  Text,
  useTheme,
  type Column,
} from '@orderloop/ui';
import { useState } from 'react';
import { CodIssues } from '../../components/logistics/CodIssues';
import { OutstandingOrders } from '../../components/logistics/OutstandingOrders';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { StatementImportSheet } from '../../components/logistics/StatementImportSheet';
import { COURIER_NAME } from '../../lib/couriers';
import {
  BATCH_LABEL,
  BATCH_TONE,
  useBatches,
  useOpenDiscrepancies,
  useOutstanding,
} from '../../lib/finance';
import { formatShortDay } from '../../lib/format';
import { formatPrice } from '../../lib/money';
import { useCan } from '../../core/permissions';

const CHIPS = [
  { value: 'all', label: 'All' },
  { value: 'needs_attention', label: BATCH_LABEL.needs_attention },
  { value: 'ready', label: BATCH_LABEL.ready },
  { value: 'reconciled', label: BATCH_LABEL.reconciled },
];

const label = (b: SettlementBatch) => b.statementRef ?? b.fileName ?? 'Statement';
const difference = (b: SettlementBatch) => (
  <Text numeric tone={b.differenceMinor < 0 ? 'danger' : 'default'}>
    {formatPrice(b.differenceMinor)}
  </Text>
);

/** The money a discrepancy puts in doubt: expected less reported, where both are known. */
const discrepancyValue = (list: Discrepancy[]) =>
  list.reduce(
    (n, d) =>
      d.expectedMinor !== null && d.actualMinor !== null
        ? n + Math.abs(d.expectedMinor - d.actualMinor)
        : n,
    0,
  );

const columns: Column<SettlementBatch>[] = [
  {
    key: 'ref',
    header: 'Settlement',
    flex: 2,
    minWidth: 150,
    render: (b) => (
      <Link href={`/cod/${b.id}`} weight="medium">
        {label(b)}
      </Link>
    ),
  },
  {
    key: 'courier',
    header: 'Courier',
    minWidth: 100,
    show: 'wide',
    render: (b) => COURIER_NAME[b.provider],
  },
  {
    key: 'when',
    header: 'Imported',
    minWidth: 90,
    show: 'wide',
    render: (b) => formatShortDay(b.createdAt),
  },
  {
    key: 'lines',
    header: 'Lines',
    align: 'right',
    minWidth: 60,
    show: 'desktop',
    render: (b) => String(b.rowCount),
  },
  {
    key: 'expected',
    header: 'Expected',
    align: 'right',
    minWidth: 110,
    render: (b) => formatPrice(b.expectedMinor),
  },
  {
    key: 'reported',
    header: 'Reported',
    align: 'right',
    minWidth: 110,
    render: (b) => formatPrice(b.totals.collectedMinor),
  },
  {
    key: 'charges',
    header: 'Charges',
    align: 'right',
    minWidth: 100,
    show: 'desktop',
    render: (b) => formatPrice(b.totals.chargesMinor),
  },
  {
    key: 'paid',
    header: 'Paid out',
    align: 'right',
    minWidth: 110,
    show: 'desktop',
    render: (b) => formatPrice(b.totals.netMinor),
  },
  { key: 'diff', header: 'Difference', align: 'right', minWidth: 110, render: difference },
  {
    key: 'status',
    header: 'Status',
    minWidth: 140,
    render: (b) => (
      <Badge tone={BATCH_TONE[b.status]} dot>
        {BATCH_LABEL[b.status]}
      </Badge>
    ),
  },
];

const card = (b: SettlementBatch) => (
  <Stack gap={2}>
    <Row justify="between" gap={2} align="start">
      <Stack gap={1} grow>
        <Link href={`/cod/${b.id}`} weight="medium">
          {label(b)}
        </Link>
        <Text variant="caption" tone="muted">
          {`${COURIER_NAME[b.provider]} · ${formatShortDay(b.createdAt)} · ${b.rowCount} lines`}
        </Text>
      </Stack>
      <Badge tone={BATCH_TONE[b.status]} dot>
        {BATCH_LABEL[b.status]}
      </Badge>
    </Row>
    <Row justify="between" gap={2} wrap>
      <Text variant="small" tone="muted">{`Reported ${formatPrice(b.totals.collectedMinor)}`}</Text>
      {difference(b)}
    </Row>
  </Stack>
);

/**
 * COD reconciliation: what couriers reported on their statements, what they kept, what they paid out, and what is still
 * owed. All figures are as of now (the API holds no period). Delivered is never shown as paid.
 */
export function CodReconciliationScreen() {
  const can = useCan();
  const { colors } = useTheme();
  const batches = useBatches();
  const outstanding = useOutstanding();
  const open = useOpenDiscrepancies();
  const [importing, setImporting] = useState(false);
  const [chip, setChip] = useState('all');
  const [courier, setCourier] = useState('');

  const all = batches.data ?? [];
  const o = outstanding.data;
  // "Reported by couriers" is what the statements say they collected (all counted lines), not only the cash matched to
  // delivered orders: that is what a person sees when they open a statement. Courier charges and the payout are summed the
  // same way, so reported = paid out + courier charges.
  const reported = all.reduce((n, b) => n + b.totals.collectedMinor, 0);
  const charges = all.reduce((n, b) => n + b.totals.chargesMinor, 0);
  const paidOut = all.reduce((n, b) => n + b.totals.netMinor, 0);
  const outstandingMinor = o?.outstandingMinor ?? 0;
  const onTheWay = o?.onTheWayMinor ?? 0;
  const whole = paidOut + charges + outstandingMinor + onTheWay;
  const openList = open.data ?? [];

  const inCourier = all.filter((b) => !courier || b.provider === courier);
  const shown = inCourier.filter((b) => chip === 'all' || b.status === chip);
  const providers = [...new Set(all.map((b) => b.provider))];
  const share = (n: number) => (whole > 0 ? n / whole : 0);
  const parts = [
    { key: 'paid', name: 'Paid out', value: paidOut, color: colors.accent },
    { key: 'charges', name: 'Courier charges', value: charges, color: colors.tones.neutral.dot },
    { key: 'owed', name: 'Still outstanding', value: outstandingMinor, color: colors.danger },
    { key: 'way', name: 'With couriers, not yet due', value: onTheWay, color: colors.primary },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="COD reconciliation"
        description={`What couriers reported, what they kept and what is still owed${o ? `, as of ${formatShortDay(o.asOf)}` : ''}.`}
        actions={
          can('finance:import') ? (
            <Button icon="upload" onPress={() => setImporting(true)}>
              Import courier statement
            </Button>
          ) : undefined
        }
      />

      <QueryBoundary {...batches} refetch={() => batches.refetch()} label="Loading settlements">
        <Grid columns={{ mobile: 2, tablet: 3, desktop: 5 }}>
          <StatCard
            icon="wallet"
            label="Outstanding COD"
            value={o ? formatPrice(o.outstandingMinor) : '—'}
            tone={outstandingMinor > 0 ? 'danger' : 'default'}
            hint="Delivered, and no statement reports the cash"
          />
          <StatCard
            icon="file"
            label="Reported by couriers"
            value={formatPrice(reported)}
            hint={`On ${all.length} statement${all.length === 1 ? '' : 's'}${o ? ` · ${formatPrice(o.deliveredCollectedMinor)} matched to delivered orders` : ''}`}
          />
          <StatCard
            icon="tag"
            label="Courier charges"
            value={formatPrice(charges)}
            hint="Delivery, COD fee, returns, other"
          />
          <StatCard
            icon="check-circle"
            label="Paid out"
            value={formatPrice(paidOut)}
            hint="Reported less courier charges"
          />
          <StatCard
            icon="alert"
            label="Open discrepancies"
            value={open.data ? String(openList.length) : '—'}
            tone={openList.length > 0 ? 'danger' : 'default'}
            hint={
              open.data
                ? openList.length
                  ? `${formatPrice(discrepancyValue(openList))} in doubt`
                  : 'Nothing to review'
                : undefined
            }
          />
        </Grid>

        <Card padding="md">
          <Stack gap={4}>
            <Text variant="title" role="heading" aria-level={2}>
              {`Where the ${formatPrice(whole)} of COD is`}
            </Text>
            <ProgressBar
              label="Where the COD is"
              height={12}
              segments={parts.map((p) => ({ key: p.key, share: share(p.value), color: p.color }))}
            />
            <Row gap={5} wrap>
              {parts.map((p) => (
                <Row key={p.key} gap={2} align="center">
                  <Badge tone="neutral" dot>
                    {p.name}
                  </Badge>
                  <Text numeric weight="medium">
                    {formatPrice(p.value)}
                  </Text>
                  <Text variant="caption" tone="muted" numeric>
                    {`${(share(p.value) * 100).toFixed(1)}%`}
                  </Text>
                </Row>
              ))}
            </Row>
            <Text variant="small" tone="muted">
              {`Delivered is not paid: only cash a courier's statement reports counts. Couriers reported ${formatPrice(reported)}, of which they kept ${formatPrice(charges)} and paid out ${formatPrice(paidOut)}. Still owed by couriers: ${formatPrice(outstandingMinor)} on delivered orders with no statement line, and ${formatPrice(onTheWay)} still on the way (not due yet).`}
            </Text>
          </Stack>
        </Card>

        <Stack gap={3}>
          <Text variant="title" role="heading" aria-level={2}>
            Settlements
          </Text>
          <Row gap={3} wrap align="center" justify="between">
            <Tabs
              variant="chips"
              label="Settlement status"
              value={chip}
              onChange={setChip}
              items={CHIPS.map((c) => ({
                ...c,
                count: inCourier.filter((b) => c.value === 'all' || b.status === c.value).length,
              }))}
            />
            <FilterMenu
              label="Courier"
              value={courier}
              onChange={setCourier}
              options={providers.map((p) => ({ value: p, label: COURIER_NAME[p] }))}
            />
          </Row>
          <DataTable
            label="Settlements"
            columns={columns}
            rows={shown}
            rowKey={(b) => b.id}
            renderCard={card}
            empty={
              <EmptyState
                icon="file"
                title={all.length ? 'No settlements match' : 'No statements imported yet'}
                action={
                  !all.length && can('finance:import') ? (
                    <Button onPress={() => setImporting(true)}>Import courier statement</Button>
                  ) : undefined
                }
              >
                {all.length
                  ? 'Try a different status or courier.'
                  : 'Import a courier statement to see which orders were paid, which were not, and where the figures disagree.'}
              </EmptyState>
            }
          />
        </Stack>
      </QueryBoundary>

      <QueryBoundary
        {...outstanding}
        refetch={() => outstanding.refetch()}
        label="Loading outstanding COD"
      >
        {o && <OutstandingOrders data={o} />}
      </QueryBoundary>

      <CodIssues />

      <StatementImportSheet open={importing} onClose={() => setImporting(false)} />
    </Stack>
  );
}
