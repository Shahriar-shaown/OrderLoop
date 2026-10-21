import { Alert, Badge, Button, Card, Row, Stack, Text } from '@orderloop/ui';
import { useState } from 'react';
import type { PendingItem } from '../../lib/socialDraftForm';
import { VariantPicker, type PickedVariant } from '../catalog/VariantPicker';

/**
 * Items the customer asked for that no catalogue product was matched to. Each one says what the customer wrote and offers
 * "Pick the product"; picking one moves it into the order's products below, with the catalogue's price. Confirming needs
 * every one of them picked or removed.
 */
export function DraftItemsPanel({
  pending,
  onPick,
  onRemove,
}: {
  pending: PendingItem[];
  onPick: (index: number, variant: PickedVariant) => void;
  onRemove: (index: number) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (pending.length === 0) return null;
  return (
    <Alert tone="warning" title="Pick the product for these items">
      <Stack gap={3}>
        {pending.map((item, i) => (
          <Card key={`${item.text}-${i}`} variant="plain" padding="sm">
            <Stack gap={2}>
              <Row gap={2} wrap justify="between">
                <Stack gap={1} grow style={{ minWidth: 200 }}>
                  <Text weight="medium">{`“${item.text}” × ${item.quantity}`}</Text>
                  <Row gap={2} wrap>
                    <Badge tone="warning">Not matched to a product</Badge>
                    {item.uncertain && <Badge tone="warning">Check this</Badge>}
                  </Row>
                </Stack>
                <Row gap={2} wrap>
                  <Button
                    variant="secondary"
                    size="sm"
                    accessibilityLabel={`Pick the product for “${item.text}”`}
                    onPress={() => setOpen(open === i ? null : i)}
                  >
                    Pick the product
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    accessibilityLabel={`Remove “${item.text}”`}
                    onPress={() => {
                      setOpen(null);
                      onRemove(i);
                    }}
                  />
                </Row>
              </Row>
              {open === i && (
                <VariantPicker
                  label={`Find a product for “${item.text}”`}
                  onPick={(variant) => {
                    setOpen(null);
                    onPick(i, variant);
                  }}
                />
              )}
            </Stack>
          </Card>
        ))}
      </Stack>
    </Alert>
  );
}
