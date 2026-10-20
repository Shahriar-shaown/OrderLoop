import type { OrderSummary } from '@orderloop/contracts';
import { formatBdPhone } from '@orderloop/domain';
import { Badge, Link, Row, Stack, Text, type Column } from '@orderloop/ui';
import { COURIER_NAME } from '../../lib/couriers';
import { formatDayTime } from '../../lib/format';
import { formatPrice } from '../../lib/money';
import { OrderStatusBadge } from './OrderStatusBadge';
import { PaymentBadge } from './PaymentBadge';

/** "Select order 1001": what a row's checkbox is called for a screen reader. */
export const selectOrderLabel = (o: OrderSummary) => `Select order ${o.orderNumber}`;

/** The courier an order is with, or "Not booked". A simulated courier says so: its parcel is not real. */
export function CourierCell({ courier }: { courier: OrderSummary['courier'] }) {
  if (!courier) return <Text tone="muted">Not booked</Text>;
  return (
    <Row gap={2} wrap>
      {courier.simulated ? (
        <Badge tone="warning">Simulated</Badge>
      ) : (
        <Text>{COURIER_NAME[courier.provider]}</Text>
      )}
    </Row>
  );
}

/**
 * The columns every list of orders shares (the orders list, a customer's history): order, customer, products, payment,
 * status, courier, date, total. `customer: false` leaves the customer out where the page is already about one person.
 */
export function orderColumns({
  customer = true,
}: { customer?: boolean } = {}): Column<OrderSummary>[] {
  return [
    {
      key: 'number',
      header: 'Order',
      minWidth: 80,
      render: (o) => (
        <Link href={`/orders/${o.id}`} weight="medium">
          {`#${o.orderNumber}`}
        </Link>
      ),
    },
    ...(customer
      ? [
          {
            key: 'customer',
            header: 'Customer',
            flex: 2,
            minWidth: 150,
            render: (o: OrderSummary) => (
              <Stack gap={1}>
                <Text weight="medium">{o.customerName}</Text>
                <Text variant="caption" tone="muted">
                  {formatBdPhone(o.phone)}
                </Text>
              </Stack>
            ),
          },
        ]
      : []),
    {
      key: 'products',
      header: 'Products',
      flex: 2,
      minWidth: 150,
      show: 'desktop',
      render: (o) => o.itemsSummary,
    },
    {
      key: 'payment',
      header: 'Payment',
      flex: 2,
      minWidth: 130,
      render: (o) => <PaymentBadge state={o.payment} />,
    },
    {
      key: 'status',
      header: 'Status',
      flex: 2,
      minWidth: 140,
      render: (o) => <OrderStatusBadge status={o.status} />,
    },
    {
      key: 'courier',
      header: 'Courier',
      flex: 1,
      minWidth: 110,
      show: 'desktop',
      render: (o) => <CourierCell courier={o.courier} />,
    },
    {
      key: 'date',
      header: 'Date',
      flex: 1,
      minWidth: 96,
      render: (o) => (
        <Text tone="muted" numeric>
          {formatDayTime(o.createdAt)}
        </Text>
      ),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      flex: 1,
      minWidth: 96,
      render: (o) => (
        <Text numeric weight="medium">
          {formatPrice(o.totalMinor)}
        </Text>
      ),
    },
  ];
}

/** An order as a card, for phones: number and total, customer, products, then the two badges. */
export function OrderCard({
  order,
  showCustomer = true,
}: {
  order: OrderSummary;
  showCustomer?: boolean;
}) {
  return (
    <Stack gap={2}>
      <Row justify="between" gap={2}>
        <Link href={`/orders/${order.id}`} weight="medium">
          {`#${order.orderNumber}`}
        </Link>
        <Text numeric weight="medium">
          {formatPrice(order.totalMinor)}
        </Text>
      </Row>
      {showCustomer && (
        <Stack gap={1}>
          <Text weight="medium">{order.customerName}</Text>
          <Text variant="caption" tone="muted">
            {formatBdPhone(order.phone)}
          </Text>
        </Stack>
      )}
      <Text variant="small" tone="muted">
        {order.itemsSummary}
      </Text>
      <Row gap={2} wrap>
        <OrderStatusBadge status={order.status} />
        <PaymentBadge state={order.payment} />
      </Row>
      <Text variant="caption" tone="muted" numeric>
        {formatDayTime(order.createdAt)}
      </Text>
    </Stack>
  );
}
