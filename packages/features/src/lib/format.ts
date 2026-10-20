import { DEFAULT_TIMEZONE } from '@orderloop/contracts';
import type { Locale } from '@orderloop/ui';

/** The Intl locale of each app language. English keeps en-GB: the day before the month, a 24-hour clock. */
const INTL_LOCALE: Record<Locale, string> = { en: 'en-GB', bn: 'bn-BD' };
let formatLocale: Locale = 'en';
/** The language of the app. Dates are written outside React (in lists, labels), so they read it from here. */
export function setFormatLocale(locale: Locale): void {
  formatLocale = locale;
}

/** A variant as a person names it: "Cotton tee — Red / M". */
export function variantLabel(productName: string, variantName: string): string {
  return variantName ? `${productName} — ${variantName}` : productName;
}

let businessTimezone: string = DEFAULT_TIMEZONE;
/** The signed-in business's time zone. The API groups orders and money into days in this zone, so "today" must be its day. */
export function setBusinessTimezone(timezone: string | undefined): void {
  businessTimezone = timezone || DEFAULT_TIMEZONE;
}

/** An instant is written in the business's time zone, a calendar day (YYYY-MM-DD) as the same day anywhere. */
function dateFormat(options: Intl.DateTimeFormatOptions, day = false): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(INTL_LOCALE[formatLocale], {
    ...options,
    timeZone: day ? 'UTC' : businessTimezone,
  });
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHORT_DAY = { day: 'numeric', month: 'short' } as const;

/** Format an ISO timestamp for people, in the app language and the business's time zone. */
export function formatWhen(iso: string): string {
  return dateFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/** "17 Oct" from a calendar day (YYYY-MM-DD) or an ISO instant. */
export function formatShortDay(value: string): string {
  const day = CALENDAR_DAY.test(value);
  return dateFormat(SHORT_DAY, day).format(new Date(day ? `${value}T00:00:00Z` : value));
}

/** "Sat 17 Oct" from a calendar day. */
export function formatWeekdayDay(value: string): string {
  return dateFormat({ weekday: 'short', ...SHORT_DAY }, true).format(
    new Date(`${value}T00:00:00Z`),
  );
}

/** "17 Oct, 11:30" from an ISO instant. */
export function formatDayTime(iso: string): string {
  const d = new Date(iso);
  const time = dateFormat({ hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${dateFormat(SHORT_DAY).format(d)}, ${time}`;
}

/** "Saturday, 17 October 2026": the day of `at` in the business's time zone. */
export function formatLongDate(at: Date): string {
  return dateFormat({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(at);
}

/**
 * A calendar day (YYYY-MM-DD) `days` before today, in the business's time zone (not the device's): a phone abroad, or a
 * server in UTC, must ask for the same day the API counts.
 */
export function dayBefore(days: number, now: Date = new Date()): string {
  const today = now.toLocaleDateString('en-CA', { timeZone: businessTimezone });
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}
