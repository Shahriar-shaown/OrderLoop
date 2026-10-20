import { describe, expect, it } from 'vitest';
import { formatPrice, formatPriceShort, parsePrice, priceToInput } from './money';

describe('parsePrice', () => {
  it('turns what a person types into integer paisa', () => {
    expect(parsePrice('1250')).toBe(125000);
    expect(parsePrice('1250.5')).toBe(125050);
    expect(parsePrice('1,250.50')).toBe(125050);
    expect(parsePrice('৳ 99')).toBe(9900);
    expect(parsePrice('0')).toBe(0);
  });

  it('refuses anything that is not a sensible amount', () => {
    for (const bad of ['', '  ', 'abc', '-5', '1.234', '12e3', '99999999999'])
      expect(parsePrice(bad)).toBeNull();
  });
});

describe('formatPrice and priceToInput', () => {
  it('shows taka with lakh/crore grouping', () => {
    expect(formatPrice(125050)).toBe('৳1,250.50');
    expect(formatPrice(12_500_000)).toBe('৳1,25,000.00');
  });

  it('round-trips through the input form', () => {
    for (const minor of [0, 5, 100, 125050, 99999])
      expect(parsePrice(priceToInput(minor))).toBe(minor);
    expect(priceToInput(125000)).toBe('1250');
    expect(priceToInput(125005)).toBe('1250.05');
  });
});

describe('amounts typed on a Bangla keyboard', () => {
  it('are read like the ASCII digits', () => {
    expect(parsePrice('১২৫০')).toBe(125_000);
    expect(parsePrice('৳১,২৫০.৫০')).toBe(125_050);
  });
});

describe('formatPriceShort at unit boundaries', () => {
  it('promotes the unit instead of printing 100k or 100L', () => {
    expect(formatPriceShort(9_999_900)).toBe('৳1L'); // 99,999 taka
    expect(formatPriceShort(999_999_900)).toBe('৳1Cr'); // 9,999,999 taka
    expect(formatPriceShort(1_250_000)).toBe('৳12.5k');
    expect(formatPriceShort(85_000)).toBe('৳850');
  });
});
