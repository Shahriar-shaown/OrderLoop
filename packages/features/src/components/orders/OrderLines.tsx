import {
  Badge,
  Button,
  Card,
  Icon,
  QuantityStepper,
  Row,
  Stack,
  Text,
  TextField,
  useTheme,
} from '@orderloop/ui';
import { useState } from 'react';
import { Alert } from '@orderloop/ui';
import { View } from 'react-native';
import type { FormErrors } from '../../forms/errors';
import { formatPrice, parsePrice, priceToInput } from '../../lib/money';
import { VariantPicker, type PickedVariant } from '../catalog/VariantPicker';

/** One product on the order form. Text fields stay text until the form is sent. */
export interface Line {
  variantId: string;
  sku: string;
  label: string;
  catalogPriceMinor: number;
  /** Sellable stock when the line was added; null for a line loaded from a saved order (its stock is already held or unknown). */
  available: number | null;
  reorderPoint: number;
  /** What one unit costs you; null when you have not entered it. */
  costMinor: number | null;
  quantity: string;
  unitPrice: string;
  discount: string;
  /** A line made from a customer's message (a social draft): what they wrote, and whether it was read with low confidence. */
  fromChat?: { text: string; check: boolean };
}

export const lineFromVariant = (v: PickedVariant): Line => ({
  variantId: v.id,
  sku: v.sku,
  label: v.label,
  catalogPriceMinor: v.priceMinor,
  available: v.available,
  reorderPoint: v.reorderPoint,
  costMinor: v.costMinor,
  quantity: '1',
  unitPrice: '',
  discount: '',
});

export const first = (errors: FormErrors, ...paths: string[]): string | undefined =>
  paths.map((p) => errors[p]).find(Boolean);

/** Lines that would leave stock below the reorder point or ask for more than is available. `short` ones cannot be confirmed. */
export function stockIssues(lines: Line[]): { text: string; short: boolean }[] {
  const out: { text: string; short: boolean }[] = [];
  for (const l of lines) {
    if (l.available === null) continue;
    const q = Number(l.quantity) || 0;
    if (q > l.available)
      out.push({
        text: `${l.label}: only ${l.available} available, ${q} on this order.`,
        short: true,
      });
    else if (l.available - q < l.reorderPoint)
      out.push({
        text: `${l.label}: only ${l.available} left. After this order ${l.available - q} remain, below the reorder point of ${l.reorderPoint}.`,
        short: false,
      });
  }
  return out;
}

function LineRow({
  line,
  total,
  errors,
  index,
  onChange,
  onRemove,
}: {
  line: Line;
  total: number | undefined;
  errors: FormErrors;
  index: number;
  onChange: (patch: Partial<Line>) => void;
  onRemove: () => void;
}) {
  const { colors } = useTheme();
  const [pricing, setPricing] = useState(false);
  const typed = line.unitPrice.trim();
  const typedMinor = typed === '' ? null : parsePrice(typed);
  // The typed price as the app writes money (৳1,250.50); what cannot be read yet (half typed) is shown as typed.
  const unit =
    typed === ''
      ? formatPrice(line.catalogPriceMinor)
      : typedMinor === null
        ? `৳${typed}`
        : formatPrice(typedMinor);
  return (
    <Stack gap={2}>
      <Row gap={3} wrap justify="between">
        <Row gap={3} grow style={{ minWidth: 220 }}>
          <View
            aria-hidden
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              backgroundColor: colors.subtle,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="tag" size={18} color={colors.muted} />
          </View>
          <Stack gap={1} grow>
            <Text weight="medium">{line.label}</Text>
            <Text variant="caption" tone="muted">
              {line.sku}
              {line.available !== null ? ` · ${line.available} in stock` : ''}
            </Text>
            {line.fromChat && (
              <Row gap={2} wrap>
                <Text variant="caption" tone="muted">
                  Customer wrote
                </Text>
                <Text variant="caption">{`“${line.fromChat.text}”`}</Text>
                {line.fromChat.check && <Badge tone="warning">Check this</Badge>}
              </Row>
            )}
          </Stack>
        </Row>
        <Row gap={3} wrap>
          <QuantityStepper
            label={`Quantity (${line.sku})`}
            value={line.quantity}
            onChange={(quantity) => onChange({ quantity })}
          />
          <Text variant="small" tone="muted" numeric>{`× ${unit}`}</Text>
          <Text weight="medium" numeric style={{ minWidth: 80 }} align="right">
            {total !== undefined ? formatPrice(total) : '—'}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            accessibilityLabel={`Remove ${line.sku}`}
            onPress={onRemove}
          />
        </Row>
      </Row>
      {first(errors, `items.${index}.quantity`, `lines.${index}.quantity`) && (
        <Text variant="caption" tone="danger">
          {first(errors, `items.${index}.quantity`, `lines.${index}.quantity`)}
        </Text>
      )}
      {pricing ? (
        <Row gap={2} wrap align="start">
          <View style={{ flex: 1, minWidth: 150 }}>
            <TextField
              label={`Price ৳ (${line.sku})`}
              kind="decimal"
              placeholder={priceToInput(line.catalogPriceMinor)}
              value={line.unitPrice}
              onChangeText={(unitPrice) => onChange({ unitPrice })}
              error={first(
                errors,
                `items.${index}.unitPriceMinor`,
                `lines.${index}.unitPriceMinor`,
              )}
            />
          </View>
          <View style={{ flex: 1, minWidth: 150 }}>
            <TextField
              label={`Discount ৳ (${line.sku})`}
              kind="decimal"
              value={line.discount}
              onChangeText={(discount) => onChange({ discount })}
              error={first(errors, `items.${index}.discountMinor`, `lines.${index}.discountMinor`)}
            />
          </View>
        </Row>
      ) : (
        <Row>
          <Button variant="tertiary" size="sm" onPress={() => setPricing(true)}>
            {`Change price or discount (${line.sku})`}
          </Button>
        </Row>
      )}
    </Stack>
  );
}

/** Section 3 of the order form: search the catalog, then the lines with a quantity stepper, line total and stock warnings. */
export function OrderLines({
  lines,
  lineTotals,
  errors,
  onAdd,
  onPatch,
  onRemove,
}: {
  lines: Line[];
  lineTotals: number[] | undefined;
  errors: FormErrors;
  onAdd: (v: PickedVariant) => void;
  onPatch: (index: number, patch: Partial<Line>) => void;
  onRemove: (index: number) => void;
}) {
  const issues = stockIssues(lines);
  return (
    <Stack gap={4}>
      {first(errors, 'items') && <Alert tone="error">{first(errors, 'items')}</Alert>}
      <VariantPicker onPick={onAdd} disabledIds={lines.map((l) => l.variantId)} />
      {lines.length > 0 && (
        <Card variant="plain" padding="none">
          <Stack gap={4}>
            {lines.map((l, i) => (
              <LineRow
                key={l.variantId}
                line={l}
                index={i}
                total={lineTotals?.[i]}
                errors={errors}
                onChange={(patch) => onPatch(i, patch)}
                onRemove={() => onRemove(i)}
              />
            ))}
          </Stack>
        </Card>
      )}
      {issues.map((x) => (
        <Alert key={x.text} tone="warning">
          {x.text}
        </Alert>
      ))}
    </Stack>
  );
}
