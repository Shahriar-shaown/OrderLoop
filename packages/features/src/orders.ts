import {
  DIVISIONS,
  ORDER_SOURCES,
  ORDER_STATUS_VALUES,
  type OrderSource,
  type OrderStatus,
} from '@orderloop/contracts';
import type { SelectOption, Tone } from '@orderloop/ui';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useApi } from './runtime';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_confirmation: 'Pending confirmation',
  confirmed: 'Confirmed',
  ready_to_ship: 'Ready to ship',
  shipped: 'Shipped',
  in_transit: 'In transit',
  delivered: 'Delivered',
  delivery_failed: 'Delivery failed',
  cancelled: 'Cancelled',
  return_requested: 'Return requested',
  returned: 'Returned',
};

export const STATUS_TONE: Record<OrderStatus, Tone> = {
  pending_confirmation: 'warning',
  confirmed: 'info',
  ready_to_ship: 'info',
  shipped: 'info',
  in_transit: 'info',
  delivered: 'success',
  delivery_failed: 'error',
  cancelled: 'neutral',
  return_requested: 'warning',
  returned: 'neutral',
};

/** What the button that moves an order to a status says. */
export const STATUS_ACTION: Record<OrderStatus, string> = {
  pending_confirmation: 'Back to pending',
  confirmed: 'Confirm order',
  ready_to_ship: 'Mark ready to ship',
  shipped: 'Mark shipped',
  in_transit: 'Mark in transit',
  delivered: 'Mark delivered',
  delivery_failed: 'Delivery failed',
  cancelled: 'Cancel order',
  return_requested: 'Request return',
  returned: 'Mark returned',
};

export const SOURCE_LABEL: Record<OrderSource, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  phone_call: 'Phone call',
  website: 'Website',
  walk_in: 'Walk-in',
  other: 'Other',
};

export const STATUS_OPTIONS: SelectOption[] = ORDER_STATUS_VALUES.map((s) => ({
  value: s,
  label: STATUS_LABEL[s],
}));
export const SOURCE_OPTIONS: SelectOption[] = ORDER_SOURCES.map((s) => ({
  value: s,
  label: SOURCE_LABEL[s],
}));
export const DIVISION_OPTIONS: SelectOption[] = DIVISIONS.map((d) => ({ value: d, label: d }));

export function useOrder(id: string) {
  const api = useApi();
  return useQuery({ queryKey: ['order', id], queryFn: () => api.orders.get(id) });
}

export function useCustomer(id: string) {
  const api = useApi();
  return useQuery({ queryKey: ['customer', id], queryFn: () => api.customers.get(id) });
}

/** After anything that changes an order: its lists, its page, the customer's counts and the stock figures. */
export const invalidateOrders = (client: QueryClient) =>
  Promise.all(
    [
      'orders',
      'order',
      'orderDuplicates',
      'customers',
      'customer',
      'customerOrders',
      'inventory',
      'product',
      'products',
      'lowStock',
      'movements',
      'reservations',
    ].map((k) => client.invalidateQueries({ queryKey: [k] })),
  );
