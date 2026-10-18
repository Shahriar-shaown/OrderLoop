import { CourierError } from './errors.js';

/** "60", "60.5", 60.5 or "৳60.50" to paisa, with string arithmetic (no floats). Null when it is not an amount. */
export function takaToMinor(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const text = String(value).replace(/[,\s৳]/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return undefined;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : undefined;
}

/** Providers take whole taka. An amount with paisa is refused: silently rounding someone's money is never right. */
export function wholeTaka(minor: number, label: string): number {
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new CourierError('unsupported', `${label} must be a non-negative amount`);
  if (minor % 100 !== 0)
    throw new CourierError(
      'unsupported',
      `${label} has paisa. The courier takes whole taka only: change the order's amounts so ${label.toLowerCase()} is a whole number of taka.`,
    );
  return minor / 100;
}

/** +8801712345678 to 01712345678, the form both providers expect. */
export function toLocalPhone(canonical: string): string {
  const m = /^\+880(1[3-9]\d{8})$/.exec(canonical);
  if (!m)
    throw new CourierError('unsupported', 'The phone number is not a Bangladeshi mobile number');
  return `0${m[1]}`;
}
