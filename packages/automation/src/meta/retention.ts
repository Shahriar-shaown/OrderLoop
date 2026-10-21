import type { Database } from '@orderloop/db';
import type { Logger } from '../jobs.js';

export const SOCIAL_PURGE_EVERY_MS = 3600_000;

/**
 * Delete what the Meta inbox keeps only for review: drafts nobody confirmed (or that were dismissed or confirmed) and webhook
 * events older than `retentionDays`, and expired sign-in hand-overs. A confirmed ORDER keeps no copy of the chat: it holds only
 * what a person typed into the order form. Safe to repeat and to run from several workers.
 */
export async function purgeSocialData(deps: {
  db: Database;
  retentionDays: number;
  log: Logger;
}): Promise<{ drafts: number; events: number; sessions: number }> {
  const r = await deps.db.purgeSocialData(deps.retentionDays);
  if (r.drafts || r.events || r.sessions)
    deps.log({ event: 'meta.purged', ...r, retentionDays: deps.retentionDays });
  return r;
}
