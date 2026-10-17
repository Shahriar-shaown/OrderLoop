/** Format an ISO timestamp for people, in their own locale and time zone. */
export function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

/** A variant as a person names it: "Cotton tee — Red / M". */
export function variantLabel(productName: string, variantName: string): string {
  return variantName ? `${productName} — ${variantName}` : productName;
}
