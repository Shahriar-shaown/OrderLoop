import { Inject, Injectable, Logger } from '@nestjs/common';
import { reconcileWaitingTikTokOrders, type TikTokMetrics } from '@orderloop/automation';
import { tiktokOrderSink } from '@orderloop/catalog';
import type {
  TikTokSkuLink,
  TikTokSkuLinkPage,
  TikTokSkuLinkQuery,
  UpdateTikTokSkuLinkBody,
  UpdateTikTokSkuLinkResult,
} from '@orderloop/contracts';
import { Database, type Tx } from '@orderloop/db';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import type { AuthContext } from '../common/endpoint.js';
import { variantRefs } from './orders.service.js';
import { TIKTOK_METRICS } from './tiktok.providers.js';

type LinkRow = NonNullable<Awaited<ReturnType<Tx['tikTokSkuLink']['findFirst']>>> & {
  connection: { shopName: string };
};

@Injectable()
export class TikTokSkuLinksService {
  private readonly log = new Logger('TikTokSkuLinks');

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(TIKTOK_METRICS) private readonly metrics: TikTokMetrics,
  ) {}

  /** Orders waiting for a link (`needs_mapping`) that include each SKU. */
  private async waitingCounts(
    tx: Tx,
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ id: string; n: number }[]>`
      SELECT l.id, count(o.id)::int AS n
      FROM tiktok_sku_links l
      LEFT JOIN tiktok_orders o ON o.tenant_id = l.tenant_id AND o.connection_id = l.connection_id
        AND o.stock_state = 'needs_mapping'
        AND o.line_items @> jsonb_build_array(jsonb_build_object('externalSkuId', l.external_sku_id))
      WHERE l.tenant_id = ${tenantId}::uuid AND l.id = ANY(${ids}::uuid[])
      GROUP BY l.id`;
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  private async view(tx: Tx, tenantId: string, rows: LinkRow[]): Promise<TikTokSkuLink[]> {
    const variants = await variantRefs(
      tx,
      tenantId,
      rows.map((r) => r.variantId).filter((v): v is string => v !== null),
    );
    const waiting = await this.waitingCounts(
      tx,
      tenantId,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.connectionId,
      shopName: r.connection.shopName,
      externalSkuId: r.externalSkuId,
      sellerSku: r.sellerSku,
      productName: r.productName,
      variant: r.variantId ? (variants.get(r.variantId) ?? null) : null,
      source: r.source,
      waitingOrders: waiting.get(r.id) ?? 0,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async list(auth: AuthContext, query: TikTokSkuLinkQuery): Promise<TikTokSkuLinkPage> {
    const q = query;
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.tikTokSkuLink.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(q.unmapped === true ? { variantId: null } : {}),
          ...(q.unmapped === false ? { variantId: { not: null } } : {}),
          ...(q.connectionId ? { connectionId: q.connectionId } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        include: { connection: { select: { shopName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: await this.view(tx, auth.tenantId, page),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
        unmappedCount: await tx.tikTokSkuLink.count({
          where: { tenantId: auth.tenantId, variantId: null },
        }),
      };
    });
  }

  /**
   * Map a TikTok SKU to a variant (or clear it). Audited. Orders that were waiting for the link, and orders short of stock, are
   * looked at again straight away, each in its own transaction, so the person sees the result without waiting for the next check.
   */
  async update(
    auth: AuthContext,
    id: string,
    body: UpdateTikTokSkuLinkBody,
    ip: string | null,
  ): Promise<UpdateTikTokSkuLinkResult> {
    const { link, connectionId } = await this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        const existing = await tx.tikTokSkuLink.findFirst({
          where: { id, tenantId: auth.tenantId },
          include: { connection: { select: { shopName: true } } },
        });
        if (!existing) throw ApiError.notFound('SKU link not found');
        if (body.variantId) {
          const variant = await tx.productVariant.findFirst({
            where: {
              id: body.variantId,
              tenantId: auth.tenantId,
              archivedAt: null,
              product: { status: { not: 'ARCHIVED' } },
            },
            select: { id: true },
          });
          if (!variant)
            throw new ApiError('validation_failed', 'Request validation failed', [
              { path: 'body.variantId', message: 'That variant does not exist or is archived' },
            ]);
        }
        const updated = await tx.tikTokSkuLink.update({
          where: { id },
          data: { variantId: body.variantId, source: 'manual' },
          include: { connection: { select: { shopName: true } } },
        });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: body.variantId ? 'tiktok.sku_linked' : 'tiktok.sku_unlinked',
          targetType: 'tiktok_sku_link',
          targetId: id,
          metadata: {
            variantId: body.variantId,
            previousVariantId: existing.variantId,
            source: 'manual',
          },
          ip,
        });
        const [view] = await this.view(tx, auth.tenantId, [updated]);
        return { link: view!, connectionId: updated.connectionId };
      },
    );
    let reconciledOrders = 0;
    if (body.variantId)
      reconciledOrders = await reconcileWaitingTikTokOrders(
        { db: this.db, sink: tiktokOrderSink, metrics: this.metrics },
        { tenantId: auth.tenantId, connectionId },
      );
    this.log.log(JSON.stringify({ event: 'tiktok.sku_link_updated', reconciledOrders }));
    // The waiting count changed with the reconcile: read the link again.
    const fresh = await this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const row = await tx.tikTokSkuLink.findFirstOrThrow({
        where: { id, tenantId: auth.tenantId },
        include: { connection: { select: { shopName: true } } },
      });
      return (await this.view(tx, auth.tenantId, [row]))[0]!;
    });
    return { link: fresh ?? link, reconciledOrders };
  }
}
