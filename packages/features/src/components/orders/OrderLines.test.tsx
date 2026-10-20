import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../../test/mount';
import { OrderLines, type Line } from './OrderLines';

const line = (unitPrice: string): Line => ({
  variantId: 'v1',
  sku: 'TEE-1',
  label: 'Cotton tee',
  catalogPriceMinor: 99_000,
  available: 5,
  reorderPoint: 1,
  costMinor: null,
  quantity: '2',
  unitPrice,
  discount: '',
});

const show = (unitPrice: string) =>
  mount(
    <OrderLines
      lines={[line(unitPrice)]}
      lineTotals={[0]}
      errors={{}}
      onAdd={vi.fn()}
      onPatch={vi.fn()}
      onRemove={vi.fn()}
    />,
    {},
  );

describe('OrderLines unit price', () => {
  it('shows the catalog price when none is typed', () => {
    show('');
    expect(screen.getByText('× ৳990.00')).toBeInTheDocument();
  });

  it('shows a typed price as money, like every other price', () => {
    show('1250.5');
    expect(screen.getByText('× ৳1,250.50')).toBeInTheDocument();
  });

  it('shows what was typed when it is not an amount yet', () => {
    show('12x');
    expect(screen.getByText('× ৳12x')).toBeInTheDocument();
  });
});
