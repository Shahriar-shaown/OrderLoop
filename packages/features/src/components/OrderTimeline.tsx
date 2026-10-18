import type { OrderDetail, OrderStatus, PaymentState, ShipmentDetail } from '@orderloop/contracts';
import { Section, Timeline, type TimelineStep } from '@orderloop/ui';
import { COURIER_NAME, SHIPMENT_LABEL } from '../couriers';
import { formatDayTime } from '../format';
import { SOURCE_LABEL, STATUS_LABEL } from '../orders';

/** The usual road of an order. A status off it (in transit, delivery failed, a return) is placed by `ROAD_POSITION`. */
const ROAD: OrderStatus[] = [
  'pending_confirmation',
  'confirmed',
  'ready_to_ship',
  'shipped',
  'delivered',
];
const ROAD_POSITION: Partial<Record<OrderStatus, number>> = { in_transit: 3 };

const PROBLEM: OrderStatus[] = ['cancelled', 'delivery_failed'];
const UNSETTLED: PaymentState[] = ['cod_pending', 'cod_unpaid', 'cod_partial'];

interface Dated {
  at: string;
  step: TimelineStep;
}

/**
 * The order's story: every status change (who, when, why) and what the courier reported, with real timestamps only. What
 * is still to come is listed without dates: nothing here promises a delivery or settlement day.
 */
export function OrderTimeline({
  order,
  shipment,
  payment,
}: {
  order: OrderDetail;
  shipment?: ShipmentDetail | undefined;
  payment?: PaymentState | null | undefined;
}) {
  const past: Dated[] = order.history.map((h) => {
    const created = h.fromStatus === null;
    const by = h.actorName ? `by ${h.actorName}` : '';
    const reason = h.reason && !(created && h.reason === 'Order created') ? h.reason : '';
    const detail = created
      ? [`Via ${SOURCE_LABEL[order.source]}`, by].filter(Boolean).join(' · ')
      : [reason, by].filter(Boolean).join(' · ');
    return {
      at: h.createdAt,
      step: {
        key: h.id,
        title: created ? 'Order created' : STATUS_LABEL[h.toStatus],
        meta: formatDayTime(h.createdAt),
        ...(detail ? { detail } : {}),
        state: PROBLEM.includes(h.toStatus) ? 'problem' : 'done',
      },
    };
  });
  for (const e of shipment?.events ?? []) {
    if (!e.applied || !e.mappedStatus) continue;
    const at = e.occurredAt ?? e.createdAt;
    const who = COURIER_NAME[shipment!.provider];
    const detail =
      e.mappedStatus === 'booked'
        ? [who, shipment!.consignmentId ? `consignment ${shipment!.consignmentId}` : '']
            .filter(Boolean)
            .join(' · ')
        : (e.providerStatus ?? '');
    past.push({
      at,
      step: {
        key: `event-${e.id}`,
        title: e.mappedStatus === 'booked' ? 'Courier booked' : SHIPMENT_LABEL[e.mappedStatus],
        meta: formatDayTime(at),
        ...(detail ? { detail } : {}),
        state: ['delivery_failed', 'booking_failed'].includes(e.mappedStatus) ? 'problem' : 'done',
      },
    });
  }
  past.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const position = ROAD_POSITION[order.status] ?? ROAD.indexOf(order.status);
  const todo: TimelineStep[] =
    position >= 0
      ? ROAD.slice(position + 1).map((s) => ({
          key: `todo-${s}`,
          title: STATUS_LABEL[s],
          state: 'todo' as const,
        }))
      : [];
  if (payment && UNSETTLED.includes(payment))
    todo.push({
      key: 'todo-cash',
      title: 'Cash settled',
      detail: 'Appears when a courier statement reports the cash. No date is promised.',
      state: 'todo',
    });

  const steps = past.map((p) => p.step);
  const last = steps[steps.length - 1];
  if (last && last.state === 'done' && todo.length > 0)
    steps[steps.length - 1] = { ...last, state: 'current' };

  return (
    <Section title="Order timeline">
      <Timeline label="Order timeline" steps={[...steps, ...todo]} />
    </Section>
  );
}
