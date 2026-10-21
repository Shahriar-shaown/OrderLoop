import { Database, type Prisma } from '@orderloop/db';
import type { JobQueue, Logger } from '../jobs.js';
import { enqueueSocialEvent } from './jobs.js';
import type { MetaEvent } from './parse.js';

export interface IngestDeps {
  db: Database;
  queue: JobQueue;
  log: Logger;
  /** How long to wait for the queue before answering anyway (the stored event is picked up by the sweeper). */
  queueTimeoutMs?: number;
}

export interface IngestedEvent {
  tenantId: string;
  eventId: string;
  /** The message id (or derived key) Meta gave it. */
  key: string;
  /** Seen before (Meta retries): nothing new was stored. */
  duplicate: boolean;
  status: 'received' | 'processed' | 'ignored' | 'failed';
  mock: boolean;
}

export interface IngestSummary {
  /** Events in the notification that we know how to read. */
  events: number;
  stored: number;
  duplicates: number;
  /** Events for an account that is not connected to any business (or was disconnected): acknowledged, nothing kept. */
  unknownAccount: number;
  /** Echoes, edits and postbacks: recorded as ignored. */
  ignored: number;
  queued: number;
  /** Not queued in time (Redis slow or down): they stay `received` and the sweeper queues them. */
  queueFailed: number;
}

/**
 * Persist events, then queue one job per event. This is the whole of what runs inside Meta's five-second window, and it is the
 * only path in (the real webhook and the mock injector both call it). The cross-business step is ONE function lookup
 * (`meta_connection_for`); everything after runs inside that business's own context.
 *
 * Idempotency: (business, connection, message id) is unique and the insert skips duplicates, so Meta's immediate retries and any
 * replay create nothing new; the queue job id is derived from the event id, so queueing twice is a no-op as well.
 */
export async function ingestEvents(
  deps: IngestDeps,
  events: readonly MetaEvent[],
): Promise<{ summary: IngestSummary; events: IngestedEvent[] }> {
  const summary: IngestSummary = {
    events: events.length,
    stored: 0,
    duplicates: 0,
    unknownAccount: 0,
    ignored: 0,
    queued: 0,
    queueFailed: 0,
  };
  const result: IngestedEvent[] = [];

  const byAccount = new Map<string, MetaEvent[]>();
  for (const e of events) {
    const k = `${e.provider}|${e.accountId}`;
    byAccount.set(k, [...(byAccount.get(k) ?? []), e]);
  }

  for (const group of byAccount.values()) {
    const first = group[0]!;
    const connection = await deps.db.metaConnectionFor(first.provider, first.accountId);
    if (!connection || connection.status === 'disconnected') {
      summary.unknownAccount += group.length;
      continue;
    }
    const { tenantId } = connection;
    const stored = await deps.db.withContext({ tenantId }, async (tx) => {
      const conn = await tx.socialConnection.findFirst({
        where: { id: connection.id, tenantId },
        select: { mock: true },
      });
      const keys = group.map((e) => e.key);
      const before = await tx.socialEvent.findMany({
        where: { tenantId, connectionId: connection.id, externalEventId: { in: keys } },
        select: { externalEventId: true },
      });
      const seen = new Set(before.map((b) => b.externalEventId));
      const now = new Date();
      await tx.socialEvent.createMany({
        skipDuplicates: true,
        data: group.map((e) => ({
          tenantId,
          connectionId: connection.id,
          provider: e.provider,
          externalEventId: e.key,
          senderId: e.senderId,
          eventType: e.eventType,
          eventTimestamp: e.timestamp,
          // Minimal on purpose: the text, and only the KIND of each attachment. No media is fetched, no URL is kept.
          payload: (e.eventType === 'message'
            ? {
                ...(e.text ? { text: e.text } : {}),
                ...(e.attachmentTypes.length
                  ? { attachments: e.attachmentTypes.map((type) => ({ type })) }
                  : {}),
              }
            : {}) as Prisma.InputJsonValue,
          status: e.eventType === 'message' ? ('received' as const) : ('ignored' as const),
          processedAt: e.eventType === 'message' ? null : now,
        })),
      });
      const rows = await tx.socialEvent.findMany({
        where: { tenantId, connectionId: connection.id, externalEventId: { in: keys } },
        select: { id: true, externalEventId: true, status: true },
      });
      return rows.map((r) => ({
        tenantId,
        eventId: r.id,
        key: r.externalEventId,
        duplicate: seen.has(r.externalEventId),
        status: r.status,
        mock: conn?.mock ?? false,
      }));
    });
    for (const s of stored) {
      result.push(s);
      if (s.duplicate) summary.duplicates++;
      else summary.stored++;
      if (s.status === 'ignored' && !s.duplicate) summary.ignored++;
      if (s.status === 'received') {
        const ok = await enqueueSocialEvent(
          deps.queue,
          { tenantId, eventId: s.eventId },
          deps.queueTimeoutMs,
        );
        if (ok) summary.queued++;
        else {
          summary.queueFailed++;
          deps.log({
            level: 'warn',
            event: 'meta.queue_failed',
            tenantId,
            outcome: 'will_be_swept',
          });
        }
      }
    }
  }
  return { summary, events: result };
}
