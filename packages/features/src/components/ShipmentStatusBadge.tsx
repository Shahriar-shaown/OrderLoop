import type { ShipmentStatus } from '@orderloop/contracts';
import { Badge } from '@orderloop/ui';
import { SHIPMENT_LABEL, SHIPMENT_TONE } from '../couriers';

/** A shipment's status as a dot and words. */
export function ShipmentStatusBadge({ status }: { status: ShipmentStatus }) {
  return (
    <Badge tone={SHIPMENT_TONE[status]} dot>
      {SHIPMENT_LABEL[status]}
    </Badge>
  );
}
