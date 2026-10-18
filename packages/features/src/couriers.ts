import type { CourierEnvironment, CourierProvider, ShipmentStatus } from '@orderloop/contracts';
import { SIMULATED_EVENTS } from '@orderloop/contracts';
import type { SelectOption, Tone } from '@orderloop/ui';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { invalidateOrders } from './orders';
import { useApi } from './runtime';

export const SHIPMENT_LABEL: Record<ShipmentStatus, string> = {
  booking: 'Booking in progress',
  booking_failed: 'Booking failed',
  booking_uncertain: 'Booking not confirmed',
  booked: 'Booked',
  picked_up: 'Picked up',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  partial_delivered: 'Partly delivered',
  delivery_failed: 'Delivery failed',
  on_hold: 'On hold',
  returning: 'Returning',
  returned: 'Returned',
  cancelled: 'Cancelled',
  unknown: 'Status not recognised',
};

export const SHIPMENT_TONE: Record<ShipmentStatus, Tone> = {
  booking: 'info',
  booking_failed: 'error',
  booking_uncertain: 'warning',
  booked: 'info',
  picked_up: 'info',
  in_transit: 'info',
  out_for_delivery: 'info',
  delivered: 'success',
  partial_delivered: 'warning',
  delivery_failed: 'error',
  on_hold: 'warning',
  returning: 'warning',
  returned: 'neutral',
  cancelled: 'neutral',
  unknown: 'warning',
};

export const ENVIRONMENT_LABEL: Record<CourierEnvironment, string> = {
  simulated: 'Simulated',
  sandbox: 'Sandbox (test account)',
  production: 'Live',
};

export const SIMULATED_EVENT_LABEL: Record<(typeof SIMULATED_EVENTS)[number], string> = {
  picked_up: 'Picked up',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  delivery_failed: 'Delivery failed',
  on_hold: 'On hold',
  returning: 'Returning',
  returned: 'Returned',
};

export const MOCK_OUTCOME_OPTIONS: SelectOption[] = [
  { value: 'success', label: 'Always succeeds' },
  { value: 'validation_error', label: 'Courier refuses the booking' },
  { value: 'rate_limited', label: 'Courier says “too many requests”' },
  { value: 'unavailable', label: 'Courier is down (outcome unknown)' },
  { value: 'timeout_before_booking', label: 'Timeout, nothing booked' },
  { value: 'timeout_after_booking', label: 'Timeout after the parcel was booked' },
];

export const providerName = (provider: CourierProvider, names?: Record<string, string>) =>
  names?.[provider] ?? provider;

export function useCouriers() {
  const api = useApi();
  return useQuery({ queryKey: ['couriers'], queryFn: () => api.couriers.list() });
}

export function useOrderShipments(orderId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['shipments', orderId],
    queryFn: () => api.shipments.forOrder(orderId),
    enabled,
  });
}

export function useShipment(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['shipment', id],
    queryFn: () => api.shipments.get(id as string),
    enabled: !!id,
  });
}

/** A shipment change can move the order too (and its stock), so both are refreshed. */
export const invalidateShipments = async (client: QueryClient) => {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['shipments'] }),
    client.invalidateQueries({ queryKey: ['shipment'] }),
    invalidateOrders(client),
  ]);
};
