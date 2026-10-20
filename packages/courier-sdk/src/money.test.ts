import { describe, expect, it } from 'vitest';
import { takaToMinor } from './money.js';

describe('takaToMinor', () => {
  it('reads amounts in several shapes to paisa', () => {
    expect(takaToMinor('60')).toBe(6000);
    expect(takaToMinor('60.5')).toBe(6050);
    expect(takaToMinor(60.5)).toBe(6050);
    expect(takaToMinor('৳1,250.25')).toBe(125_025);
  });
  it('is undefined for what is not an amount', () => {
    for (const v of [null, undefined, '', 'abc', '-5', '1.234', '1e3'])
      expect(takaToMinor(v)).toBeUndefined();
  });
  it('is undefined above the cap, so a poison webhook cannot be stored and 500 forever', () => {
    expect(takaToMinor('20000000')).toBe(2_000_000_000);
    expect(takaToMinor('20000000.01')).toBeUndefined();
    expect(takaToMinor('999999999999')).toBeUndefined();
  });
});
