/** Retries come within minutes; a key older than this can never matter again. */
export const KEY_TTL_SECONDS = 24 * 3600;
export const PURGE_EVERY_MS = 3600_000;

/** Delete idempotency keys past their day. Safe to repeat and to run in several workers at once. */
export async function purgeIdempotencyKeys(deps: {
  purge: (olderThanSeconds: number) => Promise<number>;
  log: (message: string) => void;
}): Promise<number> {
  const removed = await deps.purge(KEY_TTL_SECONDS);
  if (removed > 0) deps.log(`removed ${removed} expired idempotency keys`);
  return removed;
}
