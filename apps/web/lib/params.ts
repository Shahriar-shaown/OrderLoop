/** A query-string value as a single string (Next gives `string | string[] | undefined`). */
export const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
