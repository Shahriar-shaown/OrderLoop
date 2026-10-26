import type { OutstandingCod, OutstandingRow, UntrackedCodRow } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  EmptyState,
  Link,
  Row,
  Section,
  Stack,
  Text,
  type Column,
} from '@orderloop/ui';
import { useState } from 'react';
import { useCan } from '../../core/permissions';
import { COURIER_NAME } from '../../lib/couriers';
import { CASH_LABEL, CASH_TONE } from '../../lib/finance';
import { formatShortDay } from '../../lib/format';
import { formatPrice } from '../../lib/money';
import { RecordCashDialog } from './CodReceiptsCard';

const delivered = (r: OutstandingRow) =>
  r.deliveredAt
    ? `${formatShortDay(r.deliveredAt)}${r.ageDays !== null ? ` · ${r.ageDays}d ago` : ''}`
    : '—';

const columns: Column<OutstandingRow>[] = [
  {
    key: 'order',
    header: 'Order',
    minWidth: 90,
    render: (r) => <Link href={`/orders/${r.orderId}`} weight="medium">{`#${r.orderNumber}`}</Link>,
  },
  {
    key: 'courier',
    header: 'Courier',
    minWidth: 110,
    show: 'wide',
    render: (r) => COURIER_NAME[r.provider],
  },
  { key: 'delivered', header: 'Delivered', minWidth: 140, render: delivered },
  {
    key: 'state',
    header: 'Cash',
    minWidth: 150,
    render: (r) => (
      <Badge tone={CASH_TONE[r.state]} dot>
        {CASH_LABEL[r.state]}
      </Badge>
    ),
  },
  {
    key: 'due',
    header: 'Due',
    align: 'right',
    minWidth: 100,
    render: (r) => formatPrice(r.expectedMinor),
  },
  {
    key: 'reported',
    header: 'Reported',
    align: 'right',
    minWidth: 100,
    show: 'wide',
    render: (r) => formatPrice(r.collectedMinor),
  },
  {
    key: 'owed',
    header: 'Still owed',
    align: 'right',
    minWidth: 100,
    render: (r) => (
      <Text numeric tone={r.outstandingMinor > 0 ? 'danger' : 'default'}>
        {formatPrice(r.outstandingMinor)}
      </Text>
    ),
  },
];

const card = (r: OutstandingRow) => (
  <Stack gap={2}>
    <Row justify="between" gap={2} align="start">
      <Stack gap={1} grow>
        <Link href={`/orders/${r.orderId}`} weight="medium">{`#${r.orderNumber}`}</Link>
        <Text variant="caption" tone="muted">
          {`${COURIER_NAME[r.provider]} · delivered ${delivered(r)}`}
        </Text>
      </Stack>
      <Badge tone={CASH_TONE[r.state]} dot>
        {CASH_LABEL[r.state]}
      </Badge>
    </Row>
    <Row justify="between" gap={2}>
      <Text variant="small" tone="muted">{`Due ${formatPrice(r.expectedMinor)}`}</Text>
      <Text numeric weight="medium" tone={r.outstandingMinor > 0 ? 'danger' : 'default'}>
        {`Owed ${formatPrice(r.outstandingMinor)}`}
      </Text>
    </Row>
  </Stack>
);

const sinceDelivery = (r: UntrackedCodRow) =>
  r.deliveredAt
    ? `${formatShortDay(r.deliveredAt)}${r.ageDays !== null ? ` · ${r.ageDays}d ago` : ''}`
    : '—';

/** Delivered with no courier: no statement can report the cash, so a person records it when they collect it. */
function UntrackedOrders({ rows }: { rows: UntrackedCodRow[] }) {
  const can = useCan();
  const [recording, setRecording] = useState<UntrackedCodRow | null>(null);
  const canRecord = can('finance:adjust');
  const columns: Column<UntrackedCodRow>[] = [
    {
      key: 'order',
      header: 'Order',
      minWidth: 90,
      render: (r) => (
        <Link href={`/orders/${r.orderId}`} weight="medium">{`#${r.orderNumber}`}</Link>
      ),
    },
    { key: 'delivered', header: 'Delivered', minWidth: 140, render: sinceDelivery },
    {
      key: 'due',
      header: 'Due',
      align: 'right',
      minWidth: 100,
      render: (r) => formatPrice(r.expectedMinor),
    },
    {
      key: 'got',
      header: 'Recorded',
      align: 'right',
      minWidth: 100,
      show: 'wide',
      render: (r) => formatPrice(r.collectedMinor),
    },
    {
      key: 'owed',
      header: 'Still to collect',
      align: 'right',
      minWidth: 120,
      render: (r) => (
        <Text numeric tone="danger">
          {formatPrice(r.outstandingMinor)}
        </Text>
      ),
    },
    ...(canRecord
      ? [
          {
            key: 'act',
            header: '',
            minWidth: 150,
            render: (r: UntrackedCodRow) => (
              <Button size="sm" variant="secondary" onPress={() => setRecording(r)}>
                Record cash
              </Button>
            ),
          },
        ]
      : []),
  ];
  const card = (r: UntrackedCodRow) => (
    <Stack gap={2}>
      <Row justify="between" gap={2}>
        <Stack gap={1} grow>
          <Link href={`/orders/${r.orderId}`} weight="medium">{`#${r.orderNumber}`}</Link>
          <Text variant="caption" tone="muted">{`Delivered ${sinceDelivery(r)}`}</Text>
        </Stack>
        <Text numeric weight="medium" tone="danger">
          {`To collect ${formatPrice(r.outstandingMinor)}`}
        </Text>
      </Row>
      {canRecord && (
        <Button size="sm" variant="secondary" onPress={() => setRecording(r)}>
          Record cash
        </Button>
      )}
    </Stack>
  );
  return (
    <Stack gap={3}>
      <Alert tone="info">
        {`These delivered orders went out without a courier, so no statement can report their cash. Record it here when you collect it.`}
      </Alert>
      <DataTable
        label="Delivered without a courier"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.orderId}
        renderCard={card}
      />
      {recording && (
        <RecordCashDialog
          open
          orderId={recording.orderId}
          orderNumber={recording.orderNumber}
          outstandingMinor={recording.outstandingMinor}
          onClose={() => setRecording(null)}
        />
      )}
    </Stack>
  );
}

/** Delivered orders whose cash no courier statement has reported yet: delivered is not paid. */
export function OutstandingOrders({ data }: { data: OutstandingCod }) {
  return (
    <>
      <Section
        title="Outstanding orders"
        description="Oldest first. A delivered order stays here until a courier statement reports its cash."
      >
        <Stack gap={3}>
          <DataTable
            label="Outstanding orders"
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.orderId}
            renderCard={card}
            empty={
              <EmptyState icon="check-circle" title="Nothing outstanding">
                Every delivered courier order has its cash reported on a statement.
              </EmptyState>
            }
          />
          {data.truncated && (
            <Text tone="muted">More orders are outstanding than are listed here.</Text>
          )}
        </Stack>
      </Section>
      {data.untrackedRows.length > 0 && (
        <Section
          title="Delivered without a courier"
          description={`${data.untrackedDeliveredCount} order(s), ${formatPrice(data.untrackedDeliveredMinor)} still to collect. Not counted in the outstanding total above.`}
        >
          <UntrackedOrders rows={data.untrackedRows} />
        </Section>
      )}
    </>
  );
}
