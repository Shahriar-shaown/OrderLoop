import type { OutstandingRow } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  DataTable,
  Link,
  PageHeader,
  Row,
  Section,
  Stack,
  StatCard,
  Text,
  type Column,
} from '@orderloop/ui';
import { FinanceNav } from '../components/FinanceNav';
import { QueryBoundary } from '../components/QueryBoundary';
import { CASH_LABEL, CASH_TONE, useOutstanding } from '../finance';
import { formatWhen } from '../format';
import { formatPrice } from '../money';

export function OutstandingCodScreen() {
  const query = useOutstanding();
  const o = query.data;
  const columns: Column<OutstandingRow>[] = [
    {
      key: 'order',
      header: 'Order',
      minWidth: 90,
      render: (r) => <Link href={`/orders/${r.orderId}`}>{`#${r.orderNumber}`}</Link>,
    },
    { key: 'courier', header: 'Courier', minWidth: 100, render: (r) => r.provider },
    {
      key: 'delivered',
      header: 'Delivered',
      minWidth: 150,
      render: (r) =>
        r.deliveredAt
          ? `${formatWhen(r.deliveredAt)}${r.ageDays !== null ? ` (${r.ageDays}d ago)` : ''}`
          : '—',
    },
    {
      key: 'state',
      header: 'Cash',
      minWidth: 130,
      render: (r) => <Badge tone={CASH_TONE[r.state]}>{CASH_LABEL[r.state]}</Badge>,
    },
    {
      key: 'expected',
      header: 'COD due',
      align: 'right',
      minWidth: 110,
      render: (r) => formatPrice(r.expectedMinor),
    },
    {
      key: 'collected',
      header: 'Reported',
      align: 'right',
      minWidth: 110,
      render: (r) => formatPrice(r.collectedMinor),
    },
    {
      key: 'out',
      header: 'Still owed',
      align: 'right',
      minWidth: 110,
      render: (r) => formatPrice(r.outstandingMinor),
    },
  ];
  return (
    <Stack gap={5}>
      <PageHeader
        title="Outstanding COD"
        description="Cash couriers still owe you. A delivered order is not proof that cash arrived: it stays here until a courier statement reports it."
      />
      <FinanceNav current="/finance/outstanding" />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading outstanding COD">
        {o && (
          <Stack gap={5}>
            <Row gap={3} wrap>
              <StatCard
                label="Outstanding COD"
                value={formatPrice(o.outstandingMinor)}
                hint="Delivered, and no statement reports the cash"
                tone={o.outstandingMinor > 0 ? 'danger' : 'default'}
              />
              <StatCard
                label="Due on delivered orders"
                value={formatPrice(o.deliveredExpectedMinor)}
                hint="Courier shipments only"
              />
              <StatCard
                label="Reported by statements"
                value={formatPrice(o.deliveredCollectedMinor)}
                hint="Matched to those orders"
              />
              <StatCard
                label="Still with couriers"
                value={formatPrice(o.onTheWayMinor)}
                hint="Shipped or in transit: not yet due"
              />
            </Row>
            {o.untrackedDeliveredCount > 0 && (
              <Alert tone="info">
                {`${o.untrackedDeliveredCount} delivered order(s) with ${formatPrice(o.untrackedDeliveredMinor)} COD have no real courier shipment, so no statement can confirm their cash. They are not counted above.`}
              </Alert>
            )}
            {o.byProvider.length > 0 && (
              <Section title="By courier">
                <Stack gap={1}>
                  {o.byProvider.map((p) => (
                    <Text
                      key={p.provider}
                    >{`${p.provider}: ${formatPrice(p.outstandingMinor)} across ${p.orders} order(s)`}</Text>
                  ))}
                </Stack>
              </Section>
            )}
            <Section
              title="Orders awaiting remittance"
              description="Oldest first. Source: your orders, and the lines of imported courier statements."
            >
              {o.rows.length === 0 ? (
                <Text tone="muted">Nothing outstanding.</Text>
              ) : (
                <DataTable
                  label="Outstanding orders"
                  columns={columns}
                  rows={o.rows}
                  rowKey={(r) => r.orderId}
                />
              )}
              {o.truncated && (
                <Text tone="muted">More orders are outstanding than are listed here.</Text>
              )}
            </Section>
          </Stack>
        )}
      </QueryBoundary>
    </Stack>
  );
}
