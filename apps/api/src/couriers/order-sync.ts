import { ORDER_TRANSITIONS, type OrderStatus } from '@orderloop/domain';
import type { ShipmentStatus } from '@orderloop/contracts';

/** The order status a shipment status asks for. Anything missing here never moves an order by itself. */
const TARGET: Partial<Record<ShipmentStatus, OrderStatus>> = {
  picked_up: 'shipped',
  in_transit: 'in_transit',
  out_for_delivery: 'in_transit',
  delivered: 'delivered',
  delivery_failed: 'delivery_failed',
  returning: 'return_requested',
};

/** What a person must do, because the courier's news cannot safely change the order on its own. */
const ATTENTION: Partial<Record<ShipmentStatus, string>> = {
  partial_delivered:
    'The courier reports a partial delivery. The order was not changed: check it and record what came back.',
  returned:
    'The parcel is back with you. The order was not changed: mark it returned and say which items can be sold again.',
};

/** Statuses a courier update may pass through on its way to the one it asks for. Never cancelled, never returned. */
const THROUGH: readonly OrderStatus[] = ['shipped', 'in_transit', 'delivered', 'delivery_failed'];

export interface OrderPlan {
  /** Order statuses to move through, in order. Empty when nothing needs to change. */
  steps: OrderStatus[];
  /** Why the order is left as it is, when that deserves a word. */
  note: string | null;
}

/**
 * How to bring an order in line with a shipment update, using only moves the order state machine allows. Courier news is
 * never allowed to confirm, cancel, restock or reopen an order: it can only carry a handed-over order forward.
 */
export function planOrderMoves(order: OrderStatus, shipment: ShipmentStatus): OrderPlan {
  const attention = ATTENTION[shipment];
  if (attention) return { steps: [], note: attention };
  const target = TARGET[shipment];
  if (!target || order === target) return { steps: [], note: null };

  // Breadth-first over the order's own transitions, staying on the delivery path.
  const queue: OrderStatus[][] = [[order]];
  const seen = new Set<OrderStatus>([order]);
  while (queue.length) {
    const path = queue.shift()!;
    const last = path[path.length - 1]!;
    for (const next of ORDER_TRANSITIONS[last]) {
      if (seen.has(next)) continue;
      if (next !== target && !THROUGH.includes(next)) continue;
      // A parcel on its way back was not delivered: never pass through `delivered` to get anywhere else.
      if (next === 'delivered' && target !== 'delivered') continue;
      const extended = [...path, next];
      if (next === target) return { steps: extended.slice(1), note: null };
      seen.add(next);
      queue.push(extended);
    }
  }
  return {
    steps: [],
    note: `The order was left as ${order.replace(/_/g, ' ')}: it cannot move to ${target.replace(/_/g, ' ')} from there.`,
  };
}
