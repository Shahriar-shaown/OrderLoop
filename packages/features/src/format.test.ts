import { afterEach, describe, expect, it } from 'vitest';
import { dayBefore, setBusinessTimezone } from './format';

describe('dayBefore', () => {
  afterEach(() => setBusinessTimezone(undefined));
  // 18:30 UTC on 19 Oct is already 20 Oct, half past midnight, in Dhaka.
  const now = new Date('2026-10-19T18:30:00Z');

  it('counts days in the business time zone, not the device one', () => {
    expect(dayBefore(0, now)).toBe('2026-10-20'); // Asia/Dhaka by default
    expect(dayBefore(6, now)).toBe('2026-10-14');
    setBusinessTimezone('UTC');
    expect(dayBefore(0, now)).toBe('2026-10-19');
    setBusinessTimezone('America/Los_Angeles');
    expect(dayBefore(0, now)).toBe('2026-10-19');
  });

  it('crosses month and year ends', () => {
    expect(dayBefore(1, new Date('2026-01-01T03:00:00Z'))).toBe('2025-12-31');
    expect(dayBefore(30, new Date('2026-03-01T03:00:00Z'))).toBe('2026-01-30');
  });
});
