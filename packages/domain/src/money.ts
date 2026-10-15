/**
 * Money is always integer paisa (1 BDT = 100 paisa); never floats (architecture decision A4).
 * Only primitives live here. Pricing, discount and COD rules arrive with the orders phase.
 */
export type Paisa = number & { readonly __brand: 'Paisa' };

const BDT_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/** Parse a decimal BDT string such as "1250.5" into paisa without floating-point maths. */
export function bdtToPaisa(input: string): Paisa {
  const m = BDT_RE.exec(input.trim());
  if (!m) throw new RangeError(`Invalid BDT amount: "${input}"`);
  const [, sign, whole, frac = ''] = m;
  const paisa = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(paisa)) throw new RangeError(`BDT amount out of range: "${input}"`);
  return (sign ? -paisa : paisa) as Paisa;
}

export function assertPaisa(value: number): Paisa {
  if (!Number.isSafeInteger(value))
    throw new RangeError(`Paisa must be a safe integer, got ${value}`);
  return value as Paisa;
}

/** Plain decimal string, e.g. 125050 -> "1250.50". */
export function paisaToBdtString(paisa: Paisa): string {
  const abs = Math.abs(paisa);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${paisa < 0 ? '-' : ''}${whole}.${frac}`;
}

/** South-Asian digit grouping (lakh/crore): 12345678 -> "1,23,456.78". Display only. */
export function formatBdt(paisa: Paisa): string {
  const [whole = '0', frac = '00'] = paisaToBdtString(paisa).replace('-', '').split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${paisa < 0 ? '-' : ''}৳${grouped}.${frac}`;
}
