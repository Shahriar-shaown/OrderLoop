import type { Variant } from '@orderloop/contracts';
import { VariantInput } from '@orderloop/contracts';
import { describe, expect, it } from 'vitest';
import { emptyVariant, toVariantInput, variantToValues } from './variants';

const values = (over: Partial<ReturnType<typeof emptyVariant>> = {}) => ({
  ...emptyVariant(),
  sku: 'tee-1',
  price: '1250.50',
  ...over,
});

describe('toVariantInput', () => {
  it('converts form text to API values (paisa, integers, nulls)', () => {
    const { value, errors } = toVariantInput(
      values({ name: ' Red / M ', cost: '800', reorderPoint: '5', barcode: ' 123 ' }),
      'v',
    );
    expect(errors).toEqual({});
    expect(value).toMatchObject({
      sku: 'tee-1',
      name: 'Red / M',
      priceMinor: 125050,
      costMinor: 80000,
      reorderPoint: 5,
      barcode: '123',
    });
    expect(VariantInput.safeParse(value).success).toBe(true);
  });

  it('treats empty optional fields as absent', () => {
    const { value } = toVariantInput(values(), 'v');
    expect(value).toMatchObject({ costMinor: null, barcode: null, reorderPoint: 0 });
  });

  it('reports a bad price, cost or reorder point under the field path', () => {
    const { errors } = toVariantInput(
      values({ price: 'twelve', cost: 'x', reorderPoint: '-1' }),
      'variants.2',
    );
    expect(Object.keys(errors).sort()).toEqual([
      'variants.2.costMinor',
      'variants.2.priceMinor',
      'variants.2.reorderPoint',
    ]);
  });

  it('gives every new variant its own key (React list identity)', () => {
    expect(emptyVariant().key).not.toBe(emptyVariant().key);
  });
});

describe('variantToValues', () => {
  it('prepares an existing variant for editing', () => {
    const v = {
      id: 'abc',
      sku: 'TEE-1',
      name: 'Red',
      priceMinor: 125050,
      costMinor: null,
      barcode: null,
      reorderPoint: 0,
      productId: 'p',
      attributes: {},
      archived: false,
      stock: { onHand: 0, reserved: 0, available: 0 },
    } as Variant;
    expect(variantToValues(v)).toEqual({
      key: 'abc',
      sku: 'TEE-1',
      name: 'Red',
      price: '1250.50',
      cost: '',
      reorderPoint: '',
      barcode: '',
    });
  });
});
