import { describe, expect, it } from 'vitest';
import { currencyExponent, formatShopMoney, parseShopAmount } from './shopMoney';

describe('formatShopMoney', () => {
  it('divides by 10^exponent and writes the currency code, never a taka sign', () => {
    expect(formatShopMoney(1250, 'MYR', 2)).toBe('MYR 12.50');
    expect(formatShopMoney(500, 'JPY', 0)).toBe('JPY 500');
    expect(formatShopMoney(1234, 'KWD', 3)).toBe('KWD 1.234');
    expect(formatShopMoney(123456789, 'MYR', 2)).toBe('MYR 1,234,567.89');
    for (const text of [
      formatShopMoney(1250, 'MYR', 2),
      formatShopMoney(1250, 'BDT', 2),
      formatShopMoney(1250, 'MYR', 2, 'bn'),
    ])
      expect(text).not.toContain('৳');
  });

  it('uses the exponent of the order, not the currency table', () => {
    expect(formatShopMoney(5, 'MYR', 0)).toBe('MYR 5');
    expect(formatShopMoney(5, 'JPY', 2)).toBe('JPY 0.05');
  });

  it('writes Bangla digits for the Bangla language, still with the currency code', () => {
    expect(formatShopMoney(1250, 'MYR', 2, 'bn')).toBe('MYR ১২.৫০');
    expect(formatShopMoney(500, 'JPY', 0, 'bn')).toBe('JPY ৫০০');
  });

  it('tolerates a currency Intl does not know, a malformed code, and a strange exponent', () => {
    expect(formatShopMoney(1250, 'XYZ', 2)).toBe('XYZ 12.50');
    expect(formatShopMoney(1250, 'ringgit', 2)).toBe('ringgit 12.50');
    expect(formatShopMoney(1250, '', 2)).toBe('? 12.50');
    expect(formatShopMoney(1250, 'MYR', -1)).toBe('MYR 12.50');
    expect(formatShopMoney(1250, 'MYR', 99)).toBe('MYR 12.50');
  });

  it('writes zero and negative amounts', () => {
    expect(formatShopMoney(0, 'MYR', 2)).toBe('MYR 0.00');
    expect(formatShopMoney(-250, 'MYR', 2)).toContain('2.50');
  });
});

describe('currencyExponent and parseShopAmount', () => {
  it('knows the decimal places of common currencies and falls back to 2', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('MYR')).toBe(2);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('nope!')).toBe(2);
  });

  it('turns typed amounts into minor units, and refuses more places than the currency has', () => {
    expect(parseShopAmount('12.5', 2)).toBe(1250);
    expect(parseShopAmount('1,200', 2)).toBe(120000);
    expect(parseShopAmount('500', 0)).toBe(500);
    expect(parseShopAmount('500.5', 0)).toBeNull();
    expect(parseShopAmount('12.345', 2)).toBeNull();
    expect(parseShopAmount('abc', 2)).toBeNull();
    expect(parseShopAmount('', 2)).toBeNull();
  });
});
