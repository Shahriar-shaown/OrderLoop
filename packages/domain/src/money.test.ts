import { describe, expect, it } from 'vitest';
import { assertPaisa, bdtToPaisa, formatBdt, paisaToBdtString } from './money.js';

describe('money', () => {
  it('parses BDT strings exactly', () => {
    expect(bdtToPaisa('1250.5')).toBe(125050);
    expect(bdtToPaisa('0.07')).toBe(7);
    expect(bdtToPaisa('19.99')).toBe(1999);
    expect(bdtToPaisa('-3')).toBe(-300);
  });
  it('rejects malformed or sub-paisa input', () => {
    for (const bad of ['', 'abc', '1.234', '1,000', '.5'])
      expect(() => bdtToPaisa(bad)).toThrow(RangeError);
  });
  it('round-trips through the decimal string', () => {
    for (const p of [0, 1, 99, 100, 125050, -5])
      expect(bdtToPaisa(paisaToBdtString(assertPaisa(p)))).toBe(p);
  });
  it('formats with lakh/crore grouping', () => {
    expect(formatBdt(assertPaisa(12345678))).toBe('৳1,23,456.78');
    expect(formatBdt(assertPaisa(99900))).toBe('৳999.00');
    expect(formatBdt(assertPaisa(1000000))).toBe('৳10,000.00');
    expect(formatBdt(assertPaisa(-50))).toBe('-৳0.50');
  });
  it('rejects non-integer paisa', () => {
    expect(() => assertPaisa(1.5)).toThrow(RangeError);
  });
});
