import type { Database, Prisma, Tx } from '@orderloop/db';
import type { TikTokOrderSnapshot } from '@orderloop/domain';
import type { Logger } from '../jobs.js';
import type { SecretBox } from '../secret-box.js';
import { TikTokApiError, type TikTokShopClient } from './client.js';
import { noopTikTokMetrics, type TikTokMetrics } from './metrics.js';
import { parseTikTokOrder, snapshotFromJson } from './parse.js';
import { reportApply, type TikTokOrderSink } from './sink.js';
import { recordTikTokProblem, withTikTokShop } from './tokens.js';

export interface TikTokProcessDeps {
  db: Database;
  log: Logger;
  now: () => Date;
  sink: TikTokOrderSink;
  metrics?: TikTokMetrics;
  /** Present in live mode only: without it a live shop's order cannot be fetched (the job fails and is retried). */
  live?: { client: TikTokShopClient; vault: SecretBox } | undefined;
}

export type TikTokProcessOutcome =
  | { status: 'processed'; orderId: string }
  | { status: 'ignored'; reason: string }
  | { status: 'already' };

interface EventPayload {
  orderStatus?: string;
  onHold?: boolean;
  updateTime?: string;
  order?: unknown;
}

/** Lock the event row and set its final state, but only if nobody finished it first. False = somebody did. */
async function close(
  tx: Tx,
  ref: { tenantId: string; eventId: string },
  status: 'processed' | 'ignored' | 'failed',
  error: string | null = null,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM tiktok_events WHERE tenant_id = ${ref.tenantId}::uuid AND id = ${ref.eventId}::uuid FOR UPDATE`;
  if (!rows[0] || rows[0].status !== 'received') return false;
  await tx.tikTokEvent.update({
    where: { id: ref.eventId },
    data: { status, error, processedAt: new Date() },
  });
  return true;
}

/**
 * Turn one stored event into (or into a change of) a mirrored order and its stock effect. Runs in three steps so that no
 * transaction waits on the network: (1) read the event and the connection; (2) for a live shop, ask TikTok for the order (the
 * notification itself is only a pointer: its status is NOT trusted); (3) in one transaction, claim the event (row lock, status read
 * under the lock), upsert the order never backwards, and run the stock rules. A crash leaves the event `received`, so the queue
 * (or the sweeper) simply runs it again; two workers on one event end with one winner and one `already`.
 */
export async function processTikTokEvent(
  deps: TikTokProcessDeps,
  ref: { tenantId: string; eventId: string },
): Promise<TikTokProcessOutcome> {
  const { tenantId, eventId } = ref;
  const metrics = deps.metrics ?? noopTikTokMetrics;
  const peek = await deps.db.withContext({ tenantId }, async (tx) => {
    const event = await tx.tikTokEvent.findFirst({ where: { id: eventId, tenantId } });
    if (!event || event.status !== 'received') return null;
    const connection = await tx.tikTokConnection.findFirst({
      where: { id: event.connectionId, tenantId },
    });
    const existing =
      connection?.mock && event.orderExternalId
        ? await tx.tikTokOrder.findFirst({
            where: {
              tenantId,
              connectionId: connection.id,
              externalOrderId: event.orderExternalId,
            },
          })
        : null;
    return { event, connection, existing };
  });
  if (!peek) {
    metrics.event('already');
    return { status: 'already' };
  }
  const { event, connection, existing } = peek;

  const finish = async (
    status: 'processed' | 'ignored' | 'failed',
    reason: string | null,
  ): Promise<TikTokProcessOutcome> => {
    const won = await deps.db.withContext({ tenantId }, (tx) => close(tx, ref, status, reason));
    if (!won) {
      metrics.event('already');
      return { status: 'already' };
    }
    metrics.event(status === 'processed' ? 'processed' : status);
    return { status: 'ignored', reason: reason ?? status };
  };

  if (!connection || connection.status === 'disconnected')
    return finish('ignored', 'connection_disconnected');

  // The seller removed the app from TikTok's side: nothing we hold works any more.
  if (event.eventType === 'deauthorization') {
    const won = await deps.db.withContext({ tenantId }, async (tx) => {
      if (!(await close(tx, ref, 'processed', null))) return false;
      await tx.tikTokConnection.updateMany({
        where: { tenantId, grantId: connection.grantId, status: { not: 'disconnected' } },
        data: {
          status: 'needs_reconnect',
          lastErrorCode: 'deauthorized',
          lastErrorMessage:
            'The seller removed OrderLoop in TikTok Shop. Reconnect this shop to continue.',
        },
      });
      await tx.auditLog.createMany({
        data: [
          {
            tenantId,
            actorUserId: null,
            action: 'integration.needs_attention',
            targetType: 'tiktok_connection',
            targetId: connection.id,
            metadata: { status: 'needs_reconnect', code: 'deauthorized' },
          },
        ],
      });
      return true;
    });
    metrics.event(won ? 'processed' : 'already');
    return won ? { status: 'ignored', reason: 'deauthorized' } : { status: 'already' };
  }

  if (event.eventType !== 'order_status') return finish('ignored', 'unsupported_event');
  const orderId = event.orderExternalId;
  if (!orderId) return finish('ignored', 'no_order_id');
  const payload = (event.payload ?? {}) as EventPayload;

  // ---- 2. the order, from TikTok (live) or from the mock's own data ------------------------------------------------------------
  let snapshot: TikTokOrderSnapshot | null = null;
  if (connection.mock) {
    snapshot = payload.order ? snapshotFromJson(payload.order) : null;
    if (!snapshot && existing) {
      // A signed webhook for a mock shop names the new status: apply it to what is stored (no remote to ask).
      const stored = snapshotFromJson(rowToJson(existing));
      if (stored)
        snapshot = {
          ...stored,
          status: payload.orderStatus ?? stored.status,
          onHold: payload.onHold ?? stored.onHold,
          statusUpdatedAt: payload.updateTime ? new Date(payload.updateTime) : event.eventTimestamp,
        };
    }
    if (!snapshot) return finish('ignored', 'unknown_mock_order');
  } else {
    if (!deps.live) throw new Error('The TikTok client is not configured on this worker');
    const live = deps.live;
    try {
      const orders = await withTikTokShop(
        {
          db: deps.db,
          client: live.client,
          vault: live.vault,
          log: deps.log,
          now: deps.now,
          ...(deps.metrics ? { metrics: deps.metrics } : {}),
        },
        { tenantId, connectionId: connection.id },
        (session) => live.client.getOrders(session, [orderId]),
      );
      const raw = orders.find((o) => (o as { id?: unknown } | null)?.id === orderId);
      if (!raw) return finish('ignored', 'order_not_found');
      snapshot = parseTikTokOrder(raw, {
        region: connection.region,
        fallbackUpdatedAt: deps.now(),
      });
      if (!snapshot) return finish('ignored', 'order_unreadable');
    } catch (error) {
      if (
        error instanceof TikTokApiError &&
        (error.kind === 'token_invalid' || error.kind === 'permission')
      ) {
        await recordTikTokProblem(deps, { tenantId, connectionId: connection.id }, error.kind);
        // Not retried: nothing will change until the shop is reconnected, and the catch-up check then reads what was missed.
        return finish(
          'ignored',
          error.kind === 'token_invalid' ? 'token_invalid' : 'permission_denied',
        );
      }
      throw error; // a rate limit, an outage or a bad request: the queue retries with back-off
    }
  }

  // ---- 3. one transaction: claim the event, mirror the order, move the stock ---------------------------------------------------
  const result = await deps.db.withContext({ tenantId }, async (tx) => {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM tiktok_events WHERE tenant_id = ${tenantId}::uuid AND id = ${eventId}::uuid FOR UPDATE`;
    if (!rows[0] || rows[0].status !== 'received') return null;
    const applied = await deps.sink.apply(tx, {
      tenantId,
      connectionId: connection.id,
      mock: connection.mock,
      snapshot: snapshot!,
    });
    await tx.tikTokEvent.update({
      where: { id: eventId },
      data: { status: 'processed', processedAt: new Date(), error: null },
    });
    return applied;
  });
  if (!result) {
    metrics.event('already');
    return { status: 'already' };
  }
  metrics.event('processed');
  reportApply(metrics, result);
  deps.log({
    event: 'tiktok.event_processed',
    tenantId,
    outcome: result.applied ? result.stockState : 'older_than_stored',
  });
  return { status: 'processed', orderId: result.orderId };
}

/** A stored order row as the JSON `snapshotFromJson` reads (the mock path rebuilds a snapshot from what is stored). */
function rowToJson(o: {
  externalOrderId: string;
  status: string;
  onHold: boolean;
  statusUpdatedAt: Date | null;
  createdAtTiktok: Date | null;
  currency: string;
  currencyExponent: number;
  subtotalMinor: bigint;
  sellerDiscountMinor: bigint;
  platformDiscountMinor: bigint;
  shippingMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  fulfilmentType: string | null;
  region: string | null;
  lineItems: Prisma.JsonValue;
}): Record<string, unknown> {
  return {
    externalOrderId: o.externalOrderId,
    status: o.status,
    onHold: o.onHold,
    statusUpdatedAt: (o.statusUpdatedAt ?? new Date(0)).toISOString(),
    createdAtTiktok: o.createdAtTiktok?.toISOString() ?? null,
    currency: o.currency,
    currencyExponent: o.currencyExponent,
    subtotalMinor: o.subtotalMinor.toString(),
    sellerDiscountMinor: o.sellerDiscountMinor.toString(),
    platformDiscountMinor: o.platformDiscountMinor.toString(),
    shippingMinor: o.shippingMinor.toString(),
    taxMinor: o.taxMinor.toString(),
    totalMinor: o.totalMinor.toString(),
    fulfilmentType: o.fulfilmentType,
    region: o.region,
    lines: o.lineItems,
  };
}

/** Out of retries: record that this event failed, without its content. */
export async function markTikTokEventFailed(
  db: Database,
  ref: { tenantId: string; eventId: string },
  reason: string,
): Promise<void> {
  await db.withContext({ tenantId: ref.tenantId }, (tx) =>
    tx.tikTokEvent.updateMany({
      where: { id: ref.eventId, tenantId: ref.tenantId, status: 'received' },
      data: { status: 'failed', processedAt: new Date(), error: reason.slice(0, 200) },
    }),
  );
}
