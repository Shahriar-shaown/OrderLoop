import type { Variant, VariantInput } from '@orderloop/contracts';
import type { FormErrors } from './errors';
import { parsePrice, priceToInput } from './money';

/** Text-only form state for one variant; converted to API values (paisa, integers) only on submit. */
export interface VariantValues {
  key: string;
  sku: string;
  name: string;
  price: string;
  cost: string;
  reorderPoint: string;
  barcode: string;
  size: string;
  colour: string;
  /** Attributes the form does not show (set elsewhere, for example by an import); kept as they are on save. */
  otherAttributes: Record<string, string>;
}

let counter = 0;
export const emptyVariant = (): VariantValues => ({
  key: `v${++counter}`,
  sku: '',
  name: '',
  price: '',
  cost: '',
  reorderPoint: '',
  barcode: '',
  size: '',
  colour: '',
  otherAttributes: {},
});

export function variantToValues(v: Variant): VariantValues {
  const { size = '', colour = '', ...otherAttributes } = v.attributes;
  return {
    key: v.id,
    sku: v.sku,
    name: v.name,
    price: priceToInput(v.priceMinor),
    cost: v.costMinor === null ? '' : priceToInput(v.costMinor),
    reorderPoint: v.reorderPoint ? String(v.reorderPoint) : '',
    barcode: v.barcode ?? '',
    size,
    colour,
    otherAttributes,
  };
}

/**
 * Turn form text into a variant payload plus any problems that can only be known here (a price that is not a valid amount).
 * Everything else is validated by the same contracts schema the API uses.
 */
export function toVariantInput(
  v: VariantValues,
  prefix: string,
): {
  value: Omit<VariantInput, 'attributes'> & { attributes?: Record<string, string> };
  errors: FormErrors;
} {
  const errors: FormErrors = {};
  const price = parsePrice(v.price);
  if (price === null) errors[`${prefix}.priceMinor`] = 'Enter an amount like 1250 or 1250.50';
  const cost = v.cost.trim() === '' ? null : parsePrice(v.cost);
  if (v.cost.trim() !== '' && cost === null)
    errors[`${prefix}.costMinor`] = 'Enter an amount like 800 or 800.50';
  const reorder = v.reorderPoint.trim() === '' ? 0 : Number(v.reorderPoint);
  if (!Number.isInteger(reorder) || reorder < 0)
    errors[`${prefix}.reorderPoint`] = 'Enter a whole number, 0 or more';
  return {
    value: {
      sku: v.sku,
      // Left blank, a variant with a size or colour is called "Red / M" (the import does the same).
      name: v.name.trim() || [v.colour.trim(), v.size.trim()].filter(Boolean).join(' / '),
      priceMinor: price ?? 0,
      costMinor: cost,
      barcode: v.barcode.trim() === '' ? null : v.barcode.trim(),
      attributes: {
        ...v.otherAttributes,
        ...(v.size.trim() ? { size: v.size.trim() } : {}),
        ...(v.colour.trim() ? { colour: v.colour.trim() } : {}),
      },
      reorderPoint: Number.isInteger(reorder) && reorder >= 0 ? reorder : 0,
    } as never,
    errors,
  };
}
