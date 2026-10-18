import type { OutstandingCod, OutstandingRow } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  DataTable,
  EmptyState,
  Link,
  Row,
  Section,
  Stack,
  Text,
  type Column,
} from '@orderloop/ui';
import { COURIER_NAME } from '../couriers';
import { CASH_LABEL, CASH_TONE } from '../finance';
import { formatShortDay } from '../format';
import { formatPrice } from '../money';

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

/** Delivered orders whose cash no courier statement has reported yet: delivered is not paid. */
export function OutstandingOrders({ data }: { data: OutstandingCod }) {
  return (
    <Section
      title="Outstanding orders"
      description="Oldest first. A delivered order stays here until a courier statement reports its cash."
    >
      <Stack gap={3}>
        {data.untrackedDeliveredCount > 0 && (
          <Alert tone="info">
            {`${data.untrackedDeliveredCount} delivered order(s) with ${formatPrice(data.untrackedDeliveredMinor)} COD have no real courier shipment, so no statement can confirm their cash. They are not counted here.`}
          </Alert>
        )}
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
  );
}
