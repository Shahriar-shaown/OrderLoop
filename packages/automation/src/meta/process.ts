import type { ExtractedDraft } from '@orderloop/contracts';
import { Database, Prisma, type Tx } from '@orderloop/db';
import {
  extractDraft,
  looksLikeOrder,
  type CatalogVariant,
  type ChatMessage,
} from '@orderloop/domain';
import type { Logger } from '../jobs.js';

export interface ProcessDeps {
  db: Database;
  log: Logger;
}

export type ProcessOutcome =
  | { status: 'processed'; draftId: string; created: boolean }
  | { status: 'ignored'; reason: string }
  | { status: 'already' };

interface EventPayload {
  text?: string;
  attachments?: { type: string }[];
}

/** This business's sellable variants, as the extractor wants them. */
export async function loadCatalog(tx: Tx, tenantId: string): Promise<CatalogVariant[]> {
  const rows = await tx.productVariant.findMany({
    where: { tenantId, archivedAt: null, product: { status: { not: 'ARCHIVED' } } },
    select: { id: true, sku: true, name: true, product: { select: { name: true } } },
    take: 5000,
  });
  return rows.map((v) => ({
    variantId: v.id,
    sku: v.sku,
    productName: v.product.name,
    variantName: v.name,
  }));
}

const asMessages = (
  events: { id: string; eventTimestamp: Date; payload: Prisma.JsonValue }[],
): ChatMessage[] =>
  events.map((e) => ({
    id: e.id,
    at: e.eventTimestamp,
    text: (e.payload as EventPayload | null)?.text ?? null,
  }));

/**
 * Turn one stored event into (or add it to) a draft. Runs in the business's own context, in one transaction, so a crash leaves
 * the event `received` and the queue (or the sweeper) simply runs it again. Safe to repeat and to run twice at once: the event
 * row is locked and its status is read under the lock, and one conversation is handled by one worker at a time (advisory lock).
 *
 * - A message from someone with an OPEN draft is added to it and extraction runs again over all of its messages (edits a
 *   person typed are kept separately and are not overwritten).
 * - Otherwise a draft is started only if the message looks like an order. Chit-chat is not kept: the event becomes `ignored`
 *   and its text is removed (data minimisation).
 * - Messages are ordered by their own timestamp, not by arrival.
 */
export async function processSocialEvent(
  deps: ProcessDeps,
  ref: { tenantId: string; eventId: string },
): Promise<ProcessOutcome> {
  const { tenantId, eventId } = ref;
  return deps.db.withContext({ tenantId }, async (tx) => {
    const peek = await tx.socialEvent.findFirst({
      where: { id: eventId, tenantId },
      select: { connectionId: true, senderId: true },
    });
    if (!peek) return { status: 'already' } as const;

    // One conversation at a time. Taken BEFORE any row lock, so two events of one customer can never wait on each other.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`social|${peek.connectionId}|${peek.senderId}`}, 0))`;

    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM social_events WHERE tenant_id = ${tenantId}::uuid AND id = ${eventId}::uuid FOR UPDATE`;
    if (!locked[0] || locked[0].status !== 'received') return { status: 'already' } as const;
    const event = await tx.socialEvent.findFirstOrThrow({ where: { id: eventId, tenantId } });
    const connection = await tx.socialConnection.findFirst({
      where: { id: event.connectionId, tenantId },
    });
    if (!connection || connection.status === 'disconnected') {
      await tx.socialEvent.update({
        where: { id: eventId },
        data: { status: 'ignored', processedAt: new Date(), error: 'connection_disconnected' },
      });
      return { status: 'ignored', reason: 'connection_disconnected' } as const;
    }

    // The open draft is locked: a person confirming or dismissing it holds the same lock, so this waits for them and then
    // sees the draft closed (no row) and starts a new one, instead of attaching a message to a draft that is already an order.
    const [openLocked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM social_drafts
      WHERE tenant_id = ${tenantId}::uuid AND connection_id = ${event.connectionId}::uuid AND sender_id = ${event.senderId}
        AND status = 'needs_review'
      FOR UPDATE`;
    const open = openLocked
      ? await tx.socialDraft.findFirstOrThrow({ where: { id: openLocked.id, tenantId } })
      : null;
    const catalog = await loadCatalog(tx, tenantId);

    // The same customer's other messages that nobody has processed yet (they arrive in bursts and workers run them in any
    // order) are handled together with this one, so the result does not depend on which job runs first.
    const siblings = await tx.socialEvent.findMany({
      where: {
        tenantId,
        connectionId: event.connectionId,
        senderId: event.senderId,
        status: 'received',
        eventType: 'message',
        id: { not: eventId },
      },
      orderBy: [{ eventTimestamp: 'asc' }, { id: 'asc' }],
      take: 50,
    });
    if (siblings.length)
      await tx.$queryRaw`
        SELECT id FROM social_events WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${siblings.map((e) => e.id)}::uuid[]) FOR UPDATE`;
    const batch = [event, ...siblings];
    const batchMessages = asMessages(batch);

    let sourceIds: string[] = [];
    let messages: ChatMessage[] = batchMessages;
    if (open) {
      sourceIds = (open.sourceEventIds as string[]).filter((id) => !batch.some((b) => b.id === id));
      const earlier = sourceIds.length
        ? await tx.socialEvent.findMany({
            where: { tenantId, id: { in: sourceIds } },
            select: { id: true, eventTimestamp: true, payload: true },
          })
        : [];
      messages = [...asMessages(earlier), ...batchMessages];
    } else if (!looksLikeOrder(batchMessages, catalog)) {
      const payload = event.payload as EventPayload | null;
      await tx.socialEvent.update({
        where: { id: eventId },
        data: {
          status: 'ignored',
          processedAt: new Date(),
          error: 'not_order_like',
          // keep that something arrived, not what was said
          payload: {
            removed: true,
            ...(payload?.attachments ? { attachments: payload.attachments } : {}),
          },
        },
      });
      return { status: 'ignored', reason: 'not_order_like' } as const;
    }

    const extracted: ExtractedDraft = extractDraft(messages, catalog);
    const times = messages.map((m) => new Date(m.at).getTime());
    const first = new Date(Math.min(...times));
    const last = new Date(Math.max(...times));
    const allIds = [...sourceIds, ...batch.map((b) => b.id)];
    let draftId: string;
    let created = false;
    if (open) {
      draftId = open.id;
      await tx.socialDraft.update({
        where: { id: open.id },
        data: {
          extracted: extracted as unknown as Prisma.InputJsonValue,
          sourceEventIds: allIds,
          firstMessageAt: new Date(Math.min(first.getTime(), open.firstMessageAt.getTime())),
          lastMessageAt: new Date(Math.max(last.getTime(), open.lastMessageAt.getTime())),
        },
      });
    } else {
      created = true;
      const row = await tx.socialDraft.create({
        data: {
          tenantId,
          connectionId: event.connectionId,
          senderId: event.senderId,
          extracted: extracted as unknown as Prisma.InputJsonValue,
          sourceEventIds: allIds,
          firstMessageAt: first,
          lastMessageAt: last,
          mock: connection.mock,
        },
      });
      draftId = row.id;
    }
    await tx.socialEvent.updateMany({
      where: { tenantId, id: { in: batch.map((b) => b.id) } },
      data: { status: 'processed', processedAt: new Date() },
    });
    deps.log({
      event: 'meta.event_processed',
      tenantId,
      outcome: created ? 'draft_created' : 'draft_updated',
    });
    return { status: 'processed', draftId, created } as const;
  });
}

/** Out of retries: record that this event failed, without its content. */
export async function markSocialEventFailed(
  db: Database,
  ref: { tenantId: string; eventId: string },
  reason: string,
): Promise<void> {
  await db.withContext({ tenantId: ref.tenantId }, (tx) =>
    tx.socialEvent.updateMany({
      where: { id: ref.eventId, tenantId: ref.tenantId, status: 'received' },
      data: { status: 'failed', processedAt: new Date(), error: reason.slice(0, 200) },
    }),
  );
}
