import { describe, expect, it } from 'vitest';
import { isRealDay } from './day';
import { localizeDigits, toAsciiDigits } from '../i18n/dateText';

describe('isRealDay', () => {
  it('accepts days that exist, leap days included', () => {
    for (const d of ['2026-10-20', '2024-02-29', '2026-12-31']) expect(isRealDay(d), d).toBe(true);
  });
  it('rejects shapes and days that do not exist', () => {
    for (const d of ['2026-13-45', '2026-02-31', '2025-02-29', '2026-1-5', '20261020', '', 'x'])
      expect(isRealDay(d), d).toBe(false);
  });
});

describe('Bengali numerals', () => {
  it('turn back into ASCII digits for parsing, and round-trip', () => {
    expect(toAsciiDigits('১২৫০.৫০')).toBe('1250.50');
    expect(toAsciiDigits(localizeDigits('0123456789'))).toBe('0123456789');
    expect(toAsciiDigits('abc 12')).toBe('abc 12');
  });
});
