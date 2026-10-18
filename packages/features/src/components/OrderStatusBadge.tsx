import type { OrderStatus } from '@orderloop/contracts';
import { Badge } from '@orderloop/ui';
import { STATUS_LABEL, STATUS_TONE } from '../orders';

/** The status as words (colour alone is never the message). */
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}
