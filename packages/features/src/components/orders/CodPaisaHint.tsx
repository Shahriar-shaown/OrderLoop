import { Alert } from '@orderloop/ui';
import { COD_PAISA_ADVICE } from '../../forms/errors';
import { usable, useCouriers } from '../../lib/couriers';

/**
 * A soft heads-up, before the order is confirmed, that its cash to collect has paisa and so cannot be booked with a courier.
 * Shown only when a courier is turned on (otherwise nobody is going to book one). Render it only for an order with paisa.
 */
export function CodPaisaHint() {
  const couriers = useCouriers();
  if (!couriers.data?.some(usable)) return null;
  return (
    <Alert tone="info" title="Cash to collect has paisa">
      {COD_PAISA_ADVICE}
    </Alert>
  );
}
