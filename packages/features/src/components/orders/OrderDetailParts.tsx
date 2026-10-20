import type {
  OrderCash,
  OrderDetail,
  OrderItem,
  OrderStatus,
  PaymentState,
  Shipment,
} from '@orderloop/contracts';
import { formatBdPhone } from '@orderloop/domain';
import {
  Alert,
  Avatar,
  Button,
  DataTable,
  Grid,
  KeyValueList,
  Link,
  Row,
  Section,
  StatCard,
  Stack,
  Text,
  type Column,
} from '@orderloop/ui';
import type { ReactNode } from 'react';
import { COURIER_NAME } from '../../lib/couriers';
import { formatPrice } from '../../lib/money';
import { SOURCE_LABEL, STATUS_ACTION } from '../../lib/orders';
import { PaymentBadge } from './PaymentBadge';

/** What the Next banner says for each status, in plain words. It never promises a date. */
function nextText(order: OrderDetail, live: Shipment | undefined): { title: string; text: string } {
  switch (order.status) {
    case 'pending_confirmation':
      return {
        title: 'Next: confirm this order',
        text: 'This order holds no stock yet. Confirming it reserves the items.',
      };
    case 'confirmed':
      return {
        title: 'Next: pack the items',
        text: 'Pack the order, then mark it ready to ship.',
      };
    case 'ready_to_ship':
      return live
        ? {
            title: 'Next: the courier picks up the parcel',
            text: 'The booking is made. Follow it under Courier & tracking; the courier updates this order.',
          }
        : {
            title: 'Next: book a courier',
            text: 'Use Courier & tracking to book the parcel. If you hand it over yourself, mark the order shipped.',
          };
    case 'shipped':
    case 'in_transit':
      return live
        ? {
            title: `Next: delivery by ${COURIER_NAME[live.provider]}`,
            text: 'The courier updates this automatically. You do not need to change the status yourself.',
          }
        : {
            title: 'Next: the delivery result',
            text: 'Mark the order delivered or failed once you know how it went.',
          };
    case 'delivered':
      return {
        title: 'Delivered',
        text: 'Cash on delivery counts as collected only when a courier statement reports it.',
      };
    case 'delivery_failed':
      return {
        title: 'Delivery failed',
        text: 'Try the delivery again, or turn it into a return.',
      };
    case 'return_requested':
      return {
        title: 'A return was requested',
        text: 'Mark it returned when the goods are back, or decline by marking it delivered.',
      };
    case 'returned':
      return {
        title: 'Returned',
        text: 'The goods are back and nothing is due. This order is finished.',
      };
    case 'cancelled':
      return { title: 'Cancelled', text: 'This order was cancelled. Nothing is due.' };
  }
}

/** The "Next" banner: what happens now, and the moves this order can make (the state machine decides which). */
export function NextBanner({
  order,
  live,
  moves,
  quick,
  busy,
  onMove,
}: {
  order: OrderDetail;
  live: Shipment | undefined;
  /** The statuses to offer as buttons here. */
  moves: OrderStatus[];
  /** Moves that need no dialog. */
  quick: OrderStatus[];
  busy: OrderStatus | null;
  onMove: (status: OrderStatus, isQuick: boolean) => void;
}) {
  const { title, text } = nextText(order, live);
  const ended = order.status === 'cancelled' || order.status === 'returned';
  return (
    <Alert
      tone={ended ? 'neutral' : 'info'}
      title={title}
      icon="truck"
      action={
        moves.length > 0 ? (
          <Row gap={2} wrap>
            {moves.map((m, i) => (
              <Button
                key={m}
                size="sm"
                variant={i === 0 ? 'primary' : 'secondary'}
                loading={busy === m}
                onPress={() => onMove(m, quick.includes(m))}
              >
                {STATUS_ACTION[m]}
              </Button>
            ))}
          </Row>
        ) : undefined
      }
    >
      {text}
    </Alert>
  );
}

/** Expected, Collected, Settled: three different things, each named for what it is. */
export function CashTiles({
  order,
  cash,
  live,
}: {
  order: OrderDetail;
  /** Only for a role that can read finance; without it the Collected and Settled tiles are left out. */
  cash: OrderCash | undefined;
  live: Shipment | undefined;
}) {
  const reported = !!cash && cash.lines > 0;
  const by = live ? COURIER_NAME[live.provider] : 'the courier';
  const tiles: ReactNode[] = [
    <StatCard
      key="expected"
      label="Expected"
      value={formatPrice(order.codAmountMinor)}
      hint={
        order.codAmountMinor === 0
          ? 'Paid in advance. Nothing to collect on delivery.'
          : 'The customer pays this on delivery.'
      }
    />,
  ];
  if (cash)
    tiles.push(
      <StatCard
        key="collected"
        label="Collected"
        value={formatPrice(cash.collectedMinor)}
        hint={
          reported
            ? `Reported by ${by} statement`
            : cash.hasCourierShipment || order.status !== 'delivered'
              ? 'Not yet reported'
              : 'No real courier parcel, so no statement can confirm this cash.'
        }
      />,
      <StatCard
        key="settled"
        label="Settled to you"
        value={formatPrice(cash.netMinor)}
        hint={
          reported ? `After ${formatPrice(cash.chargesMinor)} courier charges` : 'Not yet reported'
        }
      />,
    );
  return <Grid columns={{ mobile: 1, tablet: tiles.length, desktop: tiles.length }}>{tiles}</Grid>;
}

/** The lines of the order. */
export function OrderItemsSection({ order }: { order: OrderDetail }) {
  const columns: Column<OrderItem>[] = [
    {
      key: 'item',
      header: 'Item',
      flex: 3,
      minWidth: 220,
      render: (i) => (
        <Stack gap={1}>
          <Text weight="medium">
            {i.variantName ? `${i.productName} — ${i.variantName}` : i.productName}
          </Text>
          <Text variant="caption" tone="muted">
            {i.sku}
          </Text>
        </Stack>
      ),
    },
    { key: 'qty', header: 'Qty', align: 'right', minWidth: 60, render: (i) => String(i.quantity) },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      minWidth: 100,
      render: (i) => formatPrice(i.unitPriceMinor),
    },
    {
      key: 'discount',
      header: 'Discount',
      align: 'right',
      minWidth: 100,
      show: 'wide',
      render: (i) => (i.discountMinor ? `−${formatPrice(i.discountMinor)}` : '—'),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      minWidth: 110,
      render: (i) => (
        <Text numeric weight="medium">
          {formatPrice(i.lineTotalMinor)}
        </Text>
      ),
    },
  ];
  const n = order.items.length;
  return (
    <Section title={`Items · ${n} product${n === 1 ? '' : 's'}`}>
      <DataTable
        label="Order items"
        columns={columns}
        rows={order.items}
        rowKey={(i) => i.id}
        renderCard={(i) => (
          <Stack gap={1}>
            <Text weight="medium">
              {i.variantName ? `${i.productName} — ${i.variantName}` : i.productName}
            </Text>
            <Text variant="caption" tone="muted">
              {`${i.sku} · ${i.quantity} × ${formatPrice(i.unitPriceMinor)}`}
            </Text>
            <Text numeric weight="medium">
              {formatPrice(i.lineTotalMinor)}
            </Text>
          </Stack>
        )}
      />
    </Section>
  );
}

/** Who ordered: name, phone as a call link, and a way to their page. */
export function CustomerCard({ order }: { order: OrderDetail }) {
  const c = order.customer;
  return (
    <Section title="Customer" actions={<Link href={`/customers/${c.id}`}>View profile</Link>}>
      <Row gap={3}>
        <Avatar name={c.name} size={40} />
        <Text weight="medium">{c.name}</Text>
      </Row>
      <KeyValueList
        layout="inline"
        items={[
          {
            label: 'Phone',
            value: (
              <Link href={`tel:${c.phone}`} external variant="inline">
                {formatBdPhone(c.phone)}
              </Link>
            ),
          },
          { label: 'Source', value: SOURCE_LABEL[order.source] },
          ...(order.sourceReference ? [{ label: 'Reference', value: order.sourceReference }] : []),
        ]}
      />
    </Section>
  );
}

export function AddressCard({ order }: { order: OrderDetail }) {
  const a = order.shipping;
  return (
    <Section title="Delivery address">
      <Stack gap={1}>
        <Text weight="medium">{a.recipientName}</Text>
        <Text>{a.line1}</Text>
        <Text tone="muted">{`${a.area}, ${a.district}, ${a.division}${a.postalCode ? ` ${a.postalCode}` : ''}`}</Text>
        <Text tone="muted">{formatBdPhone(a.phone)}</Text>
      </Stack>
    </Section>
  );
}

/** Subtotal to COD, then the cash state in words. Expected is not collected, and collected is not settled. */
export function PriceBreakdown({
  order,
  payment,
}: {
  order: OrderDetail;
  payment: PaymentState | null | undefined;
}) {
  const n = order.items.reduce((sum, i) => sum + i.quantity, 0);
  return (
    <Section
      title="Payment & price breakdown"
      actions={payment ? <PaymentBadge state={payment} /> : undefined}
    >
      <KeyValueList
        layout="inline"
        items={[
          {
            label: `Subtotal · ${n} item${n === 1 ? '' : 's'}`,
            value: formatPrice(order.subtotalMinor),
          },
          {
            label: 'Discount',
            value: order.discountMinor ? `−${formatPrice(order.discountMinor)}` : '—',
            tone: order.discountMinor ? 'success' : 'muted',
          },
          { label: 'Delivery fee', value: formatPrice(order.deliveryChargeMinor) },
          { label: 'Order total', value: formatPrice(order.totalMinor) },
          {
            label: 'Advance paid',
            value: order.advancePaidMinor ? `−${formatPrice(order.advancePaidMinor)}` : '—',
            tone: 'muted',
          },
          {
            label: 'Total · COD to collect',
            value: formatPrice(order.codAmountMinor),
            emphasis: true,
          },
        ]}
      />
      <Text variant="caption" tone="muted">
        Expected is not collected, and collected is not settled. Cash counts as profit only after
        the courier settles it.
      </Text>
    </Section>
  );
}

/** The danger card: what cancelling does, and why it is off when it is. */
export function CancelCard({
  allowed,
  hasLiveShipment,
  onCancel,
}: {
  allowed: boolean;
  hasLiveShipment: boolean;
  onCancel: () => void;
}) {
  const blocked = !allowed || hasLiveShipment;
  return (
    <Section title="Cancel order">
      <Stack gap={3}>
        <Text tone="muted">
          {!allowed
            ? 'This order can no longer be cancelled. Parcels already with a courier can’t be cancelled: if it comes back, use “Mark as returned”.'
            : hasLiveShipment
              ? 'A courier shipment is still active. Cancel the shipment first, then cancel the order.'
              : 'Cancelling puts any reserved stock back on sale. You will be asked for a reason, and it stays in the history.'}
        </Text>
        <Row>
          <Button variant="danger" disabled={blocked} onPress={onCancel}>
            Cancel order
          </Button>
        </Row>
      </Stack>
    </Section>
  );
}
