import type { OrderStatus } from '@orderloop/contracts';
import { editScope } from '@orderloop/domain';
import {
  Alert,
  Button,
  Link,
  Menu,
  PageHeader,
  Section,
  Split,
  Stack,
  Text,
  useToast,
  type MenuItem,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOrderShipments, useShipment } from '../../lib/couriers';
import {
  AddressCard,
  CancelCard,
  CashTiles,
  CustomerCard,
  NextBanner,
  OrderItemsSection,
  PriceBreakdown,
} from '../../components/orders/OrderDetailParts';
import { OrderStatusBadge } from '../../components/orders/OrderStatusBadge';
import { OrderStatusDialog } from '../../components/orders/OrderStatusDialog';
import { OrderTimeline } from '../../components/orders/OrderTimeline';
import { PaymentBadge } from '../../components/orders/PaymentBadge';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { ShipmentPanel } from '../../components/logistics/ShipmentPanel';
import { messageFor } from '../../forms/errors';
import { formatWhen } from '../../lib/format';
import {
  invalidateOrders,
  SOURCE_LABEL,
  STATUS_ACTION,
  STATUS_LABEL,
  useOrder,
  useOrderPayment,
} from '../../lib/orders';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';

/** Moves that need no explanation can be done with one press; the rest open a dialog for the reason. */
const QUICK: OrderStatus[] = ['confirmed', 'ready_to_ship', 'shipped', 'in_transit', 'delivered'];
/** Offered in the header and the cancel card, not in the Next banner. */
const ELSEWHERE: OrderStatus[] = ['cancelled', 'return_requested', 'returned'];

export function OrderDetailScreen({ id }: { id: string }) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useOrder(id);
  const order = query.data;
  const duplicates = useQuery({
    queryKey: ['orderDuplicates', id],
    queryFn: () => api.orders.duplicates(id),
  });
  const payment = useOrderPayment(order);
  const canSeeCash = can('finance:read');
  const cash = useQuery({
    queryKey: ['orderCash', id],
    enabled: canSeeCash && !!order,
    queryFn: () => api.finance.orderCash(id),
  });
  // The shipment the page is about: the latest one that is not a failed or cancelled booking.
  const shipments = useOrderShipments(id, !!order);
  const live = (shipments.data ?? [])
    .filter((s) => s.status !== 'booking_failed' && s.status !== 'cancelled')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const shipment = useShipment(live?.id ?? null);

  const [dialog, setDialog] = useState<OrderStatus | null>(null);
  const [busy, setBusy] = useState<OrderStatus | null>(null);

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

  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading order">
      {order &&
        renderPage(
          order,
          can('orders:write'),
          order.allowedStatuses.filter((s) => !ELSEWHERE.includes(s)),
        )}
    </QueryBoundary>
  );

  function renderPage(o: NonNullable<typeof order>, write: boolean, moves: OrderStatus[]) {
    const allowed = o.allowedStatuses;
    const liveShipment = (shipments.data ?? []).some(
      (s) => s.status !== 'booking_failed' && s.status !== 'cancelled',
    );
    const canCancel = allowed.includes('cancelled') && !liveShipment;
    const menu: MenuItem[] = [
      {
        key: 'customer',
        label: 'View customer profile',
        icon: 'user',
        href: `/customers/${o.customer.id}`,
      },
      ...(write && canCancel
        ? [
            {
              key: 'cancel',
              label: 'Cancel order',
              icon: 'x' as const,
              danger: true,
              onPress: () => setDialog('cancelled'),
            },
          ]
        : []),
    ];
    return (
      <Stack gap={5}>
        <PageHeader
          breadcrumbs={[{ label: 'Orders', href: '/orders' }, { label: `#${o.orderNumber}` }]}
          title={`#${o.orderNumber}`}
          badges={
            <>
              <OrderStatusBadge status={o.status} />
              {payment.data && <PaymentBadge state={payment.data} />}
            </>
          }
          description={`Created ${formatWhen(o.createdAt)} · ${SOURCE_LABEL[o.source]}`}
          actions={
            <>
              {write && editScope(o.status) !== 'none' && (
                <Button variant="secondary" icon="edit" href={`/orders/${o.id}/edit`}>
                  Edit
                </Button>
              )}
              {write && allowed.includes('return_requested') && (
                <Button
                  variant="secondary"
                  icon="return"
                  onPress={() => setDialog('return_requested')}
                >
                  {STATUS_ACTION.return_requested}
                </Button>
              )}
              {write && allowed.includes('returned') && (
                <Button variant="secondary" icon="return" onPress={() => setDialog('returned')}>
                  {STATUS_ACTION.returned}
                </Button>
              )}
              <Menu label="More actions" items={menu} />
            </>
          }
        />

        <NextBanner
          order={o}
          live={live}
          moves={write ? moves : []}
          quick={QUICK}
          busy={busy}
          onMove={(s, isQuick) => (isQuick ? quick(s) : setDialog(s))}
        />

        {o.stockHeld && (
          <Alert tone="info">
            Stock is reserved for this order. Cancelling it puts the stock back on sale.
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

        <CashTiles order={o} cash={canSeeCash ? cash.data : undefined} live={live} />
        {canSeeCash && cash.isError && <Alert tone="error">{messageFor(cash.error)}</Alert>}

        <Split
          asideWidth={400}
          main={
            <>
              <OrderTimeline order={o} shipment={shipment.data} payment={payment.data} />
              <OrderItemsSection order={o} />
              {o.notes && (
                <Section title="Notes">
                  <Text>{o.notes}</Text>
                </Section>
              )}
            </>
          }
          aside={
            <>
              <CustomerCard order={o} />
              <AddressCard order={o} />
              <ShipmentPanel order={o} />
              <PriceBreakdown order={o} payment={payment.data} />
              {write && (
                <CancelCard
                  allowed={allowed.includes('cancelled')}
                  hasLiveShipment={liveShipment}
                  onCancel={() => setDialog('cancelled')}
                />
              )}
            </>
          }
        />

        <OrderStatusDialog order={o} status={dialog} onClose={() => setDialog(null)} />
      </Stack>
    );
  }
}
