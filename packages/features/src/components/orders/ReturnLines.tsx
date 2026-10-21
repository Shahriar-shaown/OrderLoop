import type { OrderItem } from '@orderloop/contracts';
import { QuantityStepper, SelectField, Stack, Text } from '@orderloop/ui';
import {
  lineName,
  returnedQuantity,
  type ReturnCondition,
  type ReturnPick,
  type ReturnPicks,
} from '../../lib/returns';

const CONDITIONS = [
  { value: 'RESALEABLE', label: 'Resaleable: back on the shelf' },
  { value: 'DAMAGED', label: 'Damaged: to the damaged bucket' },
];

/** One row per order line for a return: how many came back (0 = none) and in what state. Errors are keyed by line id. */
export function ReturnLines({
  items,
  picks,
  errors,
  onChange,
}: {
  items: readonly OrderItem[];
  picks: ReturnPicks;
  errors: Record<string, string>;
  onChange: (itemId: string, pick: ReturnPick) => void;
}) {
  return (
    <Stack gap={3}>
      {items.map((item) => {
        const pick = picks[item.id] ?? { quantity: String(item.quantity), condition: 'RESALEABLE' };
        const name = lineName(item);
        return (
          <Stack key={item.id} gap={2}>
            <Text weight="bold" verbatim>
              {`${name} (${item.sku})`}
            </Text>
            <Text variant="caption" tone="muted">{`${item.quantity} sent`}</Text>
            <QuantityStepper
              label={`Returned: ${item.sku}`}
              value={String(returnedQuantity(item, pick))}
              min={0}
              max={item.quantity}
              onChange={(quantity) => onChange(item.id, { ...pick, quantity })}
            />
            {returnedQuantity(item, pick) > 0 && (
              <SelectField
                label={`Condition: ${item.sku}`}
                options={CONDITIONS}
                value={pick.condition}
                onChange={(v) => onChange(item.id, { ...pick, condition: v as ReturnCondition })}
              />
            )}
            {errors[item.id] && (
              <Text tone="danger" variant="caption" role="alert">
                {errors[item.id]!}
              </Text>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}
