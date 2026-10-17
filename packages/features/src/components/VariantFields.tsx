import { FieldGrid, TextField } from '@orderloop/ui';
import type { FormErrors } from '../errors';
import type { VariantValues } from '../variants';

/** The inputs for one variant (SKU, price, ...), used when creating a product and when adding or editing a variant. */
export function VariantFields({
  value,
  onChange,
  errors,
  prefix,
  lockSku = false,
}: {
  value: VariantValues;
  onChange: (next: VariantValues) => void;
  errors: FormErrors;
  prefix: string;
  lockSku?: boolean;
}) {
  const bind = (field: keyof VariantValues, errorKey: string) => ({
    value: value[field],
    onChangeText: (text: string) => onChange({ ...value, [field]: text }),
    error: errors[`${prefix}.${errorKey}`],
  });
  return (
    <FieldGrid>
      <TextField
        label="SKU"
        {...bind('sku', 'sku')}
        editable={!lockSku}
        required
        autoCapitalize="characters"
        hint={lockSku ? 'A SKU never changes.' : 'Letters, digits . _ - ; saved in capitals.'}
      />
      <TextField
        label="Variant name"
        {...bind('name', 'name')}
        placeholder="e.g. Red / M"
        hint="Optional for single-variant products."
      />
      <TextField
        label="Price (৳)"
        {...bind('price', 'priceMinor')}
        kind="decimal"
        placeholder="1250.50"
        required
      />
      <TextField
        label="Cost (৳)"
        {...bind('cost', 'costMinor')}
        kind="decimal"
        placeholder="Optional"
      />
      <TextField
        label="Reorder at"
        {...bind('reorderPoint', 'reorderPoint')}
        kind="integer"
        placeholder="0"
        hint="Alert when available stock falls to this."
      />
      <TextField label="Barcode" {...bind('barcode', 'barcode')} placeholder="Optional" />
    </FieldGrid>
  );
}
