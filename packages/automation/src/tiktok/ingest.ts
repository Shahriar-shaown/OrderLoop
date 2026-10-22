import { Database, type Prisma } from '@orderloop/db';
import type { JobQueue, Logger } from '../jobs.js';
import { enqueueTikTokEvent } from './jobs.js';
import { noopTikTokMetrics, type TikTokMetrics } from './metrics.js';
import { snapshotToJson, type TikTokWebhookEvent } from './parse.js';

export interface TikTokIngestDeps {
  db: Database;
  queue: JobQueue;
  log: Logger;
  metrics?: TikTokMetrics;
  /** How long to wait for the queue before answering anyway (the stored event is picked up by the sweeper). */
  queueTimeoutMs?: number;
}

export interface IngestedTikTokEvent {
  tenantId: string;
  eventId: string;
  key: string;
  /** Seen before (TikTok retries): nothing new was stored. */
  duplicate: boolean;
  status: 'received' | 'processed' | 'ignored' | 'failed';
  mock: boolean;
}

export interface TikTokIngestSummary {
  stored: number;
  duplicates: number;
  /** For a shop that is not connected to any business: acknowledged, nothing kept (there is nowhere to keep it). */
  unknownShop: number;
  /** Recorded as ignored: unsupported types, packages, a disconnected shop. */
  ignored: number;
  queued: number;
  /** Not queued in time (Redis slow or down): they stay `received` and the sweeper queues them. */
  queueFailed: number;
}

/**
 * Persist one notification, then queue one job for it. This is the whole of what runs inside TikTok's three-second window, and
 * the only path in (the real webhook and the mock endpoints both call it). The cross-business step is ONE function lookup
 * (`tiktok_connection_for`); everything after runs inside that business's own context.
 *
 * Idempotency: (business, connection, notification id) is unique and the insert skips duplicates, so TikTok's retries and any
 * replay create nothing new; the queue job id is derived from the event id, so queueing twice is a no-op as well.
 */
export async function ingestTikTokEvent(
  deps: TikTokIngestDeps,
  event: TikTokWebhookEvent,
): Promise<{ summary: TikTokIngestSummary; event: IngestedTikTokEvent | null }> {
  const metrics = deps.metrics ?? noopTikTokMetrics;
  const summary: TikTokIngestSummary = {
    stored: 0,
    duplicates: 0,
    unknownShop: 0,
    ignored: 0,
    queued: 0,
    queueFailed: 0,
  };
  const connection = await deps.db.tiktokConnectionFor(event.shopId);
  if (!connection) {
    summary.unknownShop++;
    metrics.event('unknown_shop');
    return { summary, event: null };
  }
  const { tenantId } = connection;
  const disconnected = connection.status === 'disconnected';
  const supported = event.kind === 'order_status' || event.kind === 'deauthorization';
  const ignoredReason = disconnected
    ? 'connection_disconnected'
    : event.kind === 'package'
      ? 'recorded_only'
      : supported
        ? null
        : 'unsupported_event';
  // Ids and a status word only. The notification's own `data` is never stored.
  const payload: Record<string, unknown> = {
    ...(event.type !== null ? { type: event.type } : {}),
    ...(event.orderId ? { orderId: event.orderId } : {}),
    ...(event.orderStatus ? { orderStatus: event.orderStatus } : {}),
    ...(event.onHold !== null ? { onHold: event.onHold } : {}),
    ...(event.updateTime ? { updateTime: event.updateTime.toISOString() } : {}),
    ...(event.mockOrder ? { order: snapshotToJson(event.mockOrder) } : {}),
  };

  const stored = await deps.db.withContext({ tenantId }, async (tx) => {
    const conn = await tx.tikTokConnection.findFirst({
      where: { id: connection.id, tenantId },
      select: { mock: true },
    });
    const created = await tx.tikTokEvent.createMany({
      skipDuplicates: true,
      data: [
        {
          tenantId,
          connectionId: connection.id,
          externalEventId: event.key,
          eventType: event.kind,
          orderExternalId: event.orderId,
          eventTimestamp: event.timestamp,
          payload: payload as Prisma.InputJsonValue,
          status: ignoredReason ? ('ignored' as const) : ('received' as const),
          error: ignoredReason,
          processedAt: ignoredReason ? new Date() : null,
        },
      ],
    });
    const row = await tx.tikTokEvent.findFirstOrThrow({
      where: { tenantId, connectionId: connection.id, externalEventId: event.key },
      select: { id: true, status: true },
    });
    return {
      tenantId,
      eventId: row.id,
      key: event.key,
      // 0 rows inserted = the key already existed (a retry, a replay, or the same delivery racing itself).
      duplicate: created.count === 0,
      status: row.status,
      mock: conn?.mock ?? false,
    } satisfies IngestedTikTokEvent;
  });

  if (stored.duplicate) {
    summary.duplicates++;
    metrics.event('duplicate');
  } else {
    summary.stored++;
    if (stored.status === 'ignored') {
      summary.ignored++;
      metrics.event('ignored');
    } else metrics.event('stored');
  }
  // A duplicate that is still `received` (queueing failed the first time) is queued again: the job id keeps it to one job.
  if (stored.status === 'received') {
    const ok = await enqueueTikTokEvent(
      deps.queue,
      { tenantId, eventId: stored.eventId },
      deps.queueTimeoutMs,
    );
    if (ok) summary.queued++;
    else {
      summary.queueFailed++;
      metrics.event('queue_failed');
      deps.log({ level: 'warn', event: 'tiktok.queue_failed', tenantId, outcome: 'will_be_swept' });
    }
  }
  return { summary, event: stored };
}
