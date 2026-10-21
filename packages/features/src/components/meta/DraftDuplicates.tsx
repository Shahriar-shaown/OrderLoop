import type { PotentialDuplicate } from '@orderloop/contracts';
import { Alert, Checkbox, Link, Row, Stack, Text } from '@orderloop/ui';
import { formatWhen } from '../../lib/format';
import { formatPrice } from '../../lib/money';
import { STATUS_LABEL } from '../../lib/orders';

export const DIFFERENT_ORDER = 'This is a different order';

/**
 * Orders that look like a repeat of this draft, each linking to the order. When there are any and the draft can be
 * confirmed, the person must tick that this is a different order first (`onAcknowledge` given): a hint, never a block.
 */
export function DraftDuplicates({
  duplicates,
  acknowledged,
  onAcknowledge,
}: {
  duplicates: PotentialDuplicate[];
  acknowledged?: boolean;
  onAcknowledge?: (next: boolean) => void;
}) {
  if (duplicates.length === 0) return null;
  return (
    <Alert tone="warning" title="This may repeat an order that already exists">
      <Stack gap={3}>
        {duplicates.map((d) => (
          <Stack key={d.orderId} gap={1}>
            <Link href={`/orders/${d.orderId}`}>{`Order #${d.orderNumber}`}</Link>
            <Row gap={2} wrap>
              <Text variant="caption">{STATUS_LABEL[d.status]}</Text>
              <Text variant="caption">{formatPrice(d.totalMinor)}</Text>
              <Text variant="caption">{formatWhen(d.createdAt)}</Text>
            </Row>
            {d.reasons.length > 0 && <Text variant="caption">{d.reasons.join(' · ')}</Text>}
          </Stack>
        ))}
        {onAcknowledge && (
          <Checkbox
            label={DIFFERENT_ORDER}
            checked={acknowledged ?? false}
            onChange={onAcknowledge}
          />
        )}
      </Stack>
    </Alert>
  );
}
