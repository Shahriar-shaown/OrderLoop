import { afterEach, describe, expect, it } from 'vitest';
import {
  dayBefore,
  formatDayTime,
  formatLongDate,
  formatShortDay,
  formatWeekdayDay,
  formatWhen,
  setBusinessTimezone,
  setFormatLocale,
} from './format';

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

describe('dates for people', () => {
  afterEach(() => {
    setBusinessTimezone(undefined);
    setFormatLocale('en');
  });
  // 18:30 UTC on 19 Oct is 00:30 on 20 Oct in Dhaka (+6) and 11:30 on 19 Oct in Los Angeles (-7).
  const instant = '2026-10-19T18:30:00Z';

  it('write an instant in the business time zone, not the device one', () => {
    expect(formatDayTime(instant)).toBe('20 Oct, 00:30'); // Asia/Dhaka by default
    expect(formatShortDay(instant)).toBe('20 Oct');
    expect(formatWhen(instant)).toContain('20 Oct 2026');
    setBusinessTimezone('America/Los_Angeles');
    expect(formatDayTime(instant)).toBe('19 Oct, 11:30');
    expect(formatShortDay(instant)).toBe('19 Oct');
    expect(formatWhen(instant)).toContain('19 Oct 2026');
    expect(formatLongDate(new Date(instant))).toBe('Monday, 19 October 2026');
  });

  it('keep a calendar day the same day in every time zone', () => {
    for (const zone of ['Asia/Dhaka', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      setBusinessTimezone(zone);
      expect(formatShortDay('2026-10-17')).toBe('17 Oct');
      expect(formatWeekdayDay('2026-10-17')).toBe('Sat 17 Oct');
    }
  });

  it('follow the app language: Bangla month names and Bengali digits, every format', () => {
    setFormatLocale('bn');
    const written = [
      formatWhen(instant),
      formatDayTime(instant),
      formatShortDay(instant),
      formatShortDay('2026-10-17'),
      formatWeekdayDay('2026-10-17'),
      formatLongDate(new Date(instant)),
    ];
    for (const text of written) {
      expect(text).toMatch(/[ঀ-৿]/);
      expect(text).not.toMatch(/[0-9]/);
    }
    expect(formatShortDay('2026-10-17')).toContain('১৭');
    // The zone still applies in Bangla.
    expect(formatShortDay(instant)).toContain('২০');
    setFormatLocale('en');
    expect(formatShortDay(instant)).toBe('20 Oct');
  });
});
