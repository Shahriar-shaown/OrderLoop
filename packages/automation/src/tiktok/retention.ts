import type { Database } from '@orderloop/db';
import type { Logger } from '../jobs.js';

/** Webhook events are kept this long (they hold ids only; the order itself is in the mirror). */
export const TIKTOK_EVENT_RETENTION_DAYS = 30;

/**
 * Delete webhook events older than 30 days, mirrored orders older than `orderRetentionDays` that are in a final state and hold no
 * live reservation, and expired sign-in hand-overs. Safe to repeat and to run from several workers.
 */
export async function purgeTikTokData(deps: {
  db: Database;
  orderRetentionDays: number;
  log: Logger;
}): Promise<{ events: number; orders: number; sessions: number }> {
  const r = await deps.db.purgeTikTokData(TIKTOK_EVENT_RETENTION_DAYS, deps.orderRetentionDays);
  if (r.events || r.orders || r.sessions)
    deps.log({ event: 'tiktok.purged', ...r, orderRetentionDays: deps.orderRetentionDays });
  return r;
}
