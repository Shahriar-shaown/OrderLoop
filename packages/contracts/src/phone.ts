/** Bangladeshi mobile numbers. Lives here (not in domain) because the contracts' schemas validate with it. */

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/**
 * A Bangladeshi mobile number in one canonical form, `+8801XXXXXXXXX`, or null when it is not one. Accepts the ways people
 * actually write it: 01712-345678, 01712 345 678, +8801712345678, 8801712345678, 008801712345678, 1712345678, and Bangla
 * digits (০১৭১২৩৪৫৬৭৮). Mobile operators use 013 to 019. The canonical form is what customers are matched on.
 */
export function normalizeBdPhone(input: string): string | null {
  const ascii = [...input.normalize('NFKC')]
    .map((ch) => {
      const i = BANGLA_DIGITS.indexOf(ch);
      return i === -1 ? ch : String(i);
    })
    .join('');
  let digits = ascii.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;
  const match = /^(?:880|0)?(1[3-9]\d{8})$/.exec(digits);
  return match ? `+880${match[1]}` : null;
}

/** For display: +8801712345678 -> 01712-345678. */
export function formatBdPhone(canonical: string): string {
  const m = /^\+880(1[3-9]\d{2})(\d{6})$/.exec(canonical);
  return m ? `0${m[1]}-${m[2]}` : canonical;
}
