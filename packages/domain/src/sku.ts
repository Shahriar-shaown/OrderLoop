const SKU_RE = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;

/** Canonical SKU: trimmed and upper-case. Returns null when it is not a valid SKU. */
export function normalizeSku(input: string): string | null {
  const sku = input.trim().toUpperCase();
  return SKU_RE.test(sku) ? sku : null;
}

export const SKU_RULE =
  'Use 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit';

/** Lower-cased, whitespace-collapsed key for case-insensitive uniqueness and matching of names. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
