import { MAX_MINOR } from '@orderloop/contracts';
import { assertPaisa, bdtToPaisa, formatBdt } from '@orderloop/domain';
import { toAsciiDigits } from '@orderloop/ui';

/** "1,250.50" or "1250.5" (optionally with ৳) to integer paisa, or null when it is not a valid non-negative amount. */
export function parsePrice(text: string): number | null {
  // A Bangla keyboard types ১২৫০: it is the same amount as 1250.
  const cleaned = toAsciiDigits(text).replace(/[,\s৳]/g, '');
  if (cleaned === '') return null;
  try {
    const minor = bdtToPaisa(cleaned);
    return minor >= 0 && minor <= MAX_MINOR ? minor : null;
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

/** A short amount for chart axes and tight spaces: ৳850, ৳12k, ৳1.2L (lakh), ৳2.1Cr (crore). Never for a figure a person acts on. */
export function formatPriceShort(minor: number): string {
  const taka = Math.abs(minor) / 100;
  const sign = minor < 0 ? '−' : '';
  const trim = (n: number) => String(Math.round(n * 10) / 10);
  // Rounding can reach the next unit (99,999 -> 100k): promote it (-> 1L) instead of printing "100k".
  const units = [
    { size: 10_000_000, suffix: 'Cr' },
    { size: 100_000, suffix: 'L' },
    { size: 1_000, suffix: 'k' },
  ];
  for (const [i, { size, suffix }] of units.entries()) {
    if (taka < size) continue;
    const value = Math.round((taka / size) * 10) / 10;
    const bigger = units[i - 1];
    if (bigger && value * size >= bigger.size)
      return `${sign}৳${trim((value * size) / bigger.size)}${bigger.suffix}`;
    return `${sign}৳${trim(taka / size)}${suffix}`;
  }
  return `${sign}৳${Math.round(taka)}`;
}
