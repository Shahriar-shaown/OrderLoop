import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ingestTikTokEvent,
  processTikTokEvent,
  type TikTokMetrics,
  type JobQueue,
  type TikTokWebhookEvent,
} from '@orderloop/automation';
import { tiktokOrderSink } from '@orderloop/catalog';
import type {
  TikTokMockOrderBody,
  TikTokMockResult,
  TikTokMockStatusBody,
} from '@orderloop/contracts';
import { Database } from '@orderloop/db';
import {
  currencyExponent,
  normalizeTikTokStatus,
  tikTokLineKey,
  type TikTokOrderSnapshot,
} from '@orderloop/domain';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { TIKTOK_EVENTS_QUEUE } from '../queue/queue.module.js';
import { TIKTOK_METRICS, toLogFn } from './tiktok.providers.js';
import { TikTokConnectionsService } from './connections.service.js';
import { TikTokRuntime } from './tiktok.runtime.js';

/**
 * Mock mode only: synthetic orders through the SAME pipeline a real webhook uses (`ingestTikTokEvent`: store, dedupe, queue) and
 * then the same processor the worker runs (`processTikTokEvent`), at once, so the caller can see the result. Signature
 * verification is skipped only because this never comes from TikTok; the real webhook route is exercised separately with
 * properly signed payloads. No buyer data exists in these shapes, mock or live.
 */
@Injectable()
export class TikTokMockService {
  private readonly log = new Logger('TikTokMock');

  constructor(
    private readonly db: Database,
    private readonly runtime: TikTokRuntime,
    private readonly connections: TikTokConnectionsService,
    @Inject(TIKTOK_EVENTS_QUEUE) private readonly queue: JobQueue,
    @Inject(TIKTOK_METRICS) private readonly metrics: TikTokMetrics,
  ) {}

  private async run(
    auth: AuthContext,
    connectionId: string,
    event: TikTokWebhookEvent,
  ): Promise<TikTokMockResult> {
    const logFn = toLogFn(this.log);
    const { event: stored } = await ingestTikTokEvent(
      { db: this.db, queue: this.queue, log: logFn, metrics: this.metrics },
      event,
    );
    if (!stored) throw ApiError.notFound('Mock shop not found');
    if (stored.status === 'received')
      await processTikTokEvent(
        {
          db: this.db,
          log: logFn,
          now: () => this.runtime.now(),
          sink: tiktokOrderSink,
          metrics: this.metrics,
        },
        { tenantId: auth.tenantId, eventId: stored.eventId },
      );
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const row = await tx.tikTokEvent.findFirstOrThrow({
        where: { id: stored.eventId, tenantId: auth.tenantId },
        select: { status: true },
      });
      const order = event.orderId
        ? await tx.tikTokOrder.findFirst({
            where: { tenantId: auth.tenantId, connectionId, externalOrderId: event.orderId },
            select: { id: true, stockState: true },
          })
        : null;
      return {
        mode: this.runtime.mode,
        mock: true as const,
        eventId: stored.eventId,
        notificationId: stored.key,
        duplicate: stored.duplicate,
        status: row.status,
        orderId: order?.id ?? null,
        stockState: order?.stockState ?? null,
      };
    });
  }

  private async mockConnection(auth: AuthContext, id: string) {
    this.connections.requireMock();
    const connection = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.tikTokConnection.findFirst({ where: { id, tenantId: auth.tenantId } }),
    );
    if (!connection || !connection.mock || connection.status === 'disconnected')
      throw ApiError.notFound('Mock shop not found');
    return connection;
  }

  /** A synthetic order, as TikTok would announce it: the order itself rides on the event (there is no TikTok to ask). */
  async injectOrder(auth: AuthContext, body: TikTokMockOrderBody): Promise<TikTokMockResult> {
    const connection = await this.mockConnection(auth, body.connectionId);
    const now = this.runtime.now();
    const currency = connection.currency ?? 'MYR';
    const lines = new Map<string, TikTokOrderSnapshot['lines'][number]>();
    for (const item of body.items) {
      const key = tikTokLineKey(item.skuId);
      const seen = lines.get(key);
      if (seen) seen.quantity += item.quantity;
      else
        lines.set(key, {
          key,
          externalSkuId: item.skuId,
          externalLineId: `L-${item.skuId}`,
          sellerSku: item.sellerSku ?? null,
          productName: item.productName ?? null,
          quantity: item.quantity,
          unitPriceMinor: BigInt(item.unitPriceMinor),
        });
    }
    const subtotal = [...lines.values()].reduce(
      (n, l) => n + l.unitPriceMinor * BigInt(l.quantity),
      0n,
    );
    const externalOrderId = body.externalOrderId ?? `MOCK-${randomUUID().slice(0, 12)}`;
    const updated = body.updateTime ? new Date(body.updateTime) : now;
    const status = normalizeTikTokStatus(body.status);
    const snapshot: TikTokOrderSnapshot = {
      externalOrderId,
      status,
      onHold: body.onHold,
      statusUpdatedAt: updated,
      createdAtTiktok: now,
      currency,
      currencyExponent: currencyExponent(currency),
      subtotalMinor: subtotal,
      sellerDiscountMinor: 0n,
      platformDiscountMinor: 0n,
      shippingMinor: 0n,
      taxMinor: 0n,
      totalMinor: subtotal,
      fulfilmentType: 'FULFILLED_BY_SELLER',
      region: connection.region,
      lines: [...lines.values()],
    };
    return this.run(auth, connection.id, {
      shopId: connection.shopId,
      key: body.notificationId ?? `mock_${randomUUID()}`,
      type: 1,
      kind: 'order_status',
      orderId: externalOrderId,
      orderStatus: status,
      onHold: body.onHold,
      updateTime: updated,
      timestamp: now,
      mockOrder: snapshot,
    });
  }

  /** Change a mock order's status (CANCELLED cancels it): a notification that names the new status, like a signed webhook. */
  async changeStatus(
    auth: AuthContext,
    id: string,
    body: TikTokMockStatusBody,
  ): Promise<TikTokMockResult> {
    this.connections.requireMock();
    const order = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.tikTokOrder.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { connection: { select: { shopId: true, mock: true, status: true } } },
      }),
    );
    if (!order || !order.connection.mock || order.connection.status === 'disconnected')
      throw ApiError.notFound('Mock order not found');
    const now = this.runtime.now();
    const status = normalizeTikTokStatus(body.status);
    return this.run(auth, order.connectionId, {
      shopId: order.connection.shopId,
      key: body.notificationId ?? `mock_${randomUUID()}`,
      type: 1,
      kind: 'order_status',
      orderId: order.externalOrderId,
      orderStatus: status,
      onHold: body.onHold ?? null,
      updateTime: body.updateTime ? new Date(body.updateTime) : now,
      timestamp: now,
    });
  }
}
