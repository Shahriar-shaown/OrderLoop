import type { Locale } from '@orderloop/ui';

/**
 * Money in a TikTok shop's own currency. These amounts are NEVER taka: they are not formatted with the BDT formatter, never
 * show a taka sign and are never added to a taka figure. An amount arrives as an integer in the currency's minor unit
 * (`exponent` decimal places), so MYR 12.50 is 1250 with exponent 2 and JPY 500 is 500 with exponent 0.
 */

const INTL_LOCALE: Record<Locale, string> = { en: 'en-GB', bn: 'bn-BD' };

/** How many decimal places a currency has (JPY 0, MYR 2, KWD 3); 2 for a code Intl does not know. */
export function currencyExponent(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits!;
  } catch {
    return 2;
  }
}

/** A plain amount in major units written the way a person types it ("12.50") to minor units, or null when it is not an amount. */
export function parseShopAmount(text: string, exponent: number): number | null {
  const cleaned = text.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  if (fraction.length > exponent) return null;
  const minor = Number(`${whole}${fraction.padEnd(exponent, '0')}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * "MYR 12.50" (English) or "MYR ১২.৫০" (Bangla): the amount divided by 10^exponent, written after the currency's CODE, so it
 * can never be mistaken for taka. Written by hand (not Intl's currency style) so the code always comes first, whatever the
 * language and ICU version, and so an unknown currency code needs no special case.
 */
export function formatShopMoney(
  minor: number,
  currency: string,
  exponent: number,
  locale: Locale = 'en',
): string {
  const places = Number.isInteger(exponent) && exponent >= 0 && exponent <= 10 ? exponent : 2;
  const number = new Intl.NumberFormat(INTL_LOCALE[locale], {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(minor / 10 ** places);
  return `${currency.trim() || '?'} ${number}`;
}
