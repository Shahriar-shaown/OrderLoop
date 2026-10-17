import { assertPaisa, bdtToPaisa, formatBdt } from '@orderloop/domain';

/** "1,250.50" or "1250.5" (optionally with ৳) to integer paisa, or null when it is not a valid non-negative amount. */
export function parsePrice(text: string): number | null {
  const cleaned = text.replace(/[,\s৳]/g, '');
  if (cleaned === '') return null;
  try {
    const minor = bdtToPaisa(cleaned);
    return minor >= 0 && minor <= 2_000_000_000 ? minor : null;
  } catch {
    return null;
  }
}

/** Integer paisa to a display string such as ৳1,25,000.50 (lakh/crore grouping). */
export function formatPrice(minor: number): string {
  return formatBdt(assertPaisa(minor));
}

/** Paisa to the plain decimal a user would type back into a price field. */
export function priceToInput(minor: number): string {
  const whole = Math.floor(minor / 100);
  const frac = minor % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
}
