import { CourierError } from './errors.js';

/** Same cap as MAX_MINOR in @orderloop/contracts (this package stays free of workspace dependencies). */
const MAX_MINOR = 2_000_000_000;

/** "60", "60.5", 60.5 or "৳60.50" to paisa, with string arithmetic (no floats). Undefined when it is not an amount, or above the cap. */
export function takaToMinor(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const text = String(value).replace(/[,\s৳]/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return undefined;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  // Above the cap the database would refuse the amount: a poison webhook must read as "no amount", not 500 forever.
  return Number.isSafeInteger(minor) && minor <= MAX_MINOR ? minor : undefined;
}

/** What to do about an amount with paisa, in words for the person who must fix it. */
export const paisaAdvice = (minor: number, label: string): string =>
  `${label} is ৳${(minor / 100).toFixed(2)}, which has paisa. Couriers take whole taka only, and a confirmed order cannot be edited: cancel this order and enter it again with prices, discount and delivery charge that make the cash to collect a whole number of taka.`;

/** Providers take whole taka. An amount with paisa is refused: silently rounding someone's money is never right. */
export function wholeTaka(minor: number, label: string): number {
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new CourierError('unsupported', `${label} must be a non-negative amount`);
  if (minor % 100 !== 0) throw new CourierError('unsupported', paisaAdvice(minor, label));
  return minor / 100;
}

/** +8801712345678 to 01712345678, the form both providers expect. */
export function toLocalPhone(canonical: string): string {
  const m = /^\+880(1[3-9]\d{8})$/.exec(canonical);
  if (!m)
    throw new CourierError('unsupported', 'The phone number is not a Bangladeshi mobile number');
  return `0${m[1]}`;
}
