import type { OrderDetail, OrderItem, OrderStatus } from '@orderloop/contracts';
import { editScope, formatBdPhone } from '@orderloop/domain';
import {
  Alert,
  Button,
  DataTable,
  KeyValueList,
  Link,
  PageHeader,
  Row,
  Section,
  Stack,
  Text,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { OrderStatusBadge } from '../components/OrderStatusBadge';
import { OrderStatusDialog } from '../components/OrderStatusDialog';
import { QueryBoundary } from '../components/QueryBoundary';
import { messageFor } from '../errors';
import { formatWhen } from '../format';
import { formatPrice } from '../money';
import { invalidateOrders, SOURCE_LABEL, STATUS_ACTION, STATUS_LABEL, useOrder } from '../orders';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

/** Moves that need no explanation can be done with one press; the rest open a dialog for the reason. */
const QUICK: OrderStatus[] = ['confirmed', 'ready_to_ship', 'shipped', 'in_transit', 'delivered'];

function History({ order }: { order: OrderDetail }) {
  return (
    <Stack gap={3}>
      {order.history.map((h) => (
        <Stack key={h.id} gap={1}>
          <Row gap={2} wrap>
            <OrderStatusBadge status={h.toStatus} />
            <Text variant="caption" tone="muted">
              {formatWhen(h.createdAt)}
              {h.actorName ? ` · ${h.actorName}` : ''}
            </Text>
          </Row>
          {h.fromStatus && (
            <Text variant="caption" tone="muted">
              {`From ${STATUS_LABEL[h.fromStatus].toLowerCase()}`}
            </Text>
          )}
          {h.reason && <Text>{h.reason}</Text>}
        </Stack>
      ))}
    </Stack>
  );
}

export function OrderDetailScreen({ id }: { id: string }) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useOrder(id);
  const duplicates = useQuery({
    queryKey: ['orderDuplicates', id],
    queryFn: () => api.orders.duplicates(id),
  });
  const [dialog, setDialog] = useState<OrderStatus | null>(null);
  const [busy, setBusy] = useState<OrderStatus | null>(null);
  const order = query.data;

  async function quick(status: OrderStatus) {
    if (!order) return;
    setBusy(status);
    try {
      await api.orders.changeStatus(order.id, { status, ifVersion: order.version });
      await invalidateOrders(queryClient);
      toast.success(`Order #${order.orderNumber}: ${STATUS_LABEL[status].toLowerCase()}`);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(null);
    }
  }

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
    { key: 'qty', header: 'Qty', align: 'right', minWidth: 70, render: (i) => String(i.quantity) },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      minWidth: 110,
      render: (i) => formatPrice(i.unitPriceMinor),
    },
    {
      key: 'discount',
      header: 'Discount',
      align: 'right',
      minWidth: 110,
      render: (i) => (i.discountMinor ? `−${formatPrice(i.discountMinor)}` : '—'),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      minWidth: 120,
      render: (i) => formatPrice(i.lineTotalMinor),
    },
  ];

  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading order">
      {order && (
        <Stack gap={5}>
          <PageHeader
            title={`Order #${order.orderNumber}`}
            description={`Created ${formatWhen(order.createdAt)} · ${SOURCE_LABEL[order.source]}`}
            actions={
              <Row gap={2} wrap>
                <OrderStatusBadge status={order.status} />
                <Button href="/orders" variant="secondary">
                  Back to orders
                </Button>
                {can('orders:write') && editScope(order.status) !== 'none' && (
                  <Button variant="secondary" href={`/orders/${order.id}/edit`}>
                    Edit
                  </Button>
                )}
              </Row>
            }
          />

          {can('orders:write') && order.allowedStatuses.length > 0 && (
            <Section
              title="Next step"
              description="Only the moves this order can make are offered."
            >
              <Row gap={2} wrap>
                {order.allowedStatuses.map((s) => (
                  <Button
                    key={s}
                    variant={
                      s === 'cancelled' ? 'danger' : QUICK.includes(s) ? 'primary' : 'secondary'
                    }
                    loading={busy === s}
                    onPress={() => (QUICK.includes(s) ? quick(s) : setDialog(s))}
                  >
                    {STATUS_ACTION[s]}
                  </Button>
                ))}
              </Row>
            </Section>
          )}

          {order.stockHeld && (
            <Alert tone="info">
              Stock is reserved for this order. Cancelling it puts the stock back on sale.
            </Alert>
          )}
          {order.status === 'pending_confirmation' && (
            <Alert tone="warning">
              This order holds no stock yet. Confirming it reserves the items.
            </Alert>
          )}
          {duplicates.data && duplicates.data.length > 0 && (
            <Alert tone="warning" title="Possible repeat of another recent order">
              <Stack gap={2}>
                {duplicates.data.map((d) => (
                  <Stack key={d.orderId} gap={1}>
                    <Link href={`/orders/${d.orderId}`}>{`Order #${d.orderNumber}`}</Link>
                    <Text variant="caption">{d.reasons.join(' · ')}</Text>
                  </Stack>
                ))}
                <Text variant="caption" tone="muted">
                  A hint only. It says nothing about the customer.
                </Text>
              </Stack>
            </Alert>
          )}

          <Section title="Customer and delivery">
            <KeyValueList
              items={[
                {
                  label: 'Customer',
                  value: (
                    <Link href={`/customers/${order.customer.id}`}>{order.customer.name}</Link>
                  ),
                },
                { label: 'Customer phone', value: formatBdPhone(order.customer.phone) },
                { label: 'Deliver to', value: order.shipping.recipientName },
                { label: 'Recipient phone', value: formatBdPhone(order.shipping.phone) },
                {
                  label: 'Address',
                  value: `${order.shipping.line1}, ${order.shipping.area}, ${order.shipping.district}, ${order.shipping.division}${order.shipping.postalCode ? ` ${order.shipping.postalCode}` : ''}`,
                },
                ...(order.sourceReference
                  ? [{ label: 'Source reference', value: order.sourceReference }]
                  : []),
                ...(order.notes ? [{ label: 'Notes', value: order.notes }] : []),
              ]}
            />
          </Section>

          <Section title="Items">
            <DataTable
              label="Order items"
              columns={columns}
              rows={order.items}
              rowKey={(i) => i.id}
            />
            <KeyValueList
              items={[
                { label: 'Items total', value: formatPrice(order.subtotalMinor) },
                {
                  label: 'Discount',
                  value: order.discountMinor ? `−${formatPrice(order.discountMinor)}` : '—',
                },
                { label: 'Delivery charge', value: formatPrice(order.deliveryChargeMinor) },
                { label: 'Order total', value: formatPrice(order.totalMinor) },
                { label: 'Advance paid', value: formatPrice(order.advancePaidMinor) },
                { label: 'Cash on delivery', value: formatPrice(order.codAmountMinor) },
              ]}
            />
          </Section>

          <Section
            title="Status history"
            description="Every step, who made it and why. It cannot be edited."
          >
            <History order={order} />
          </Section>

          <OrderStatusDialog order={order} status={dialog} onClose={() => setDialog(null)} />
        </Stack>
      )}
    </QueryBoundary>
  );
}
