import { Injectable } from '@nestjs/common';
import { readStoredLines } from '@orderloop/catalog';
import type {
  TikTokOrder,
  TikTokOrderLine,
  TikTokOrderPage,
  TikTokOrderQuery,
  TikTokOrderSummary,
  TikTokVariantRef,
} from '@orderloop/contracts';
import { Database, type Tx } from '@orderloop/db';
import { normalizeTikTokStatus } from '@orderloop/domain';
import { ApiError } from '../common/api-error.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import type { AuthContext } from '../common/endpoint.js';
import { TikTokRuntime } from './tiktok.runtime.js';

type OrderRow = NonNullable<Awaited<ReturnType<Tx['tikTokOrder']['findFirst']>>>;

/** Money is stored as bigint minor units; amounts that fit a JSON number are sent as numbers (anything bigger is a bug, not a price). */
export function minor(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('A TikTok amount is too large to represent');
  return n;
}

/** Variants by id, as the API shows them. */
export async function variantRefs(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, TikTokVariantRef>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.productVariant.findMany({
    where: { tenantId, id: { in: [...new Set(ids)] } },
    select: { id: true, sku: true, name: true, product: { select: { name: true } } },
  });
  return new Map(
    rows.map((v) => [
      v.id,
      { id: v.id, sku: v.sku, productName: v.product.name, variantName: v.name },
    ]),
  );
}

@Injectable()
export class TikTokOrdersService {
  constructor(
    private readonly db: Database,
    private readonly runtime: TikTokRuntime,
  ) {}

  /** The lines of the given orders with their mapping: the link's variant (or none) and the hold's state (or none). */
  private async lineViews(tx: Tx, tenantId: string, orders: readonly OrderRow[]) {
    const lines = orders.map((o) => ({ order: o, stored: readStoredLines(o.lineItems) }));
    const skuIds = [...new Set(lines.flatMap((l) => l.stored.map((s) => s.externalSkuId)))];
    const connectionIds = [...new Set(orders.map((o) => o.connectionId))];
    const [links, holds] = await Promise.all([
      skuIds.length
        ? tx.tikTokSkuLink.findMany({
            where: { tenantId, connectionId: { in: connectionIds }, externalSkuId: { in: skuIds } },
            select: { id: true, connectionId: true, externalSkuId: true, variantId: true },
          })
        : [],
      orders.length
        ? tx.tikTokStockHold.findMany({
            where: { tenantId, tiktokOrderId: { in: orders.map((o) => o.id) } },
            select: { tiktokOrderId: true, lineKey: true, state: true, variantId: true },
          })
        : [],
    ]);
    const linkKey = (connectionId: string, sku: string) => `${connectionId}|${sku}`;
    const linkBy = new Map(links.map((l) => [linkKey(l.connectionId, l.externalSkuId), l]));
    const holdBy = new Map(holds.map((h) => [`${h.tiktokOrderId}|${h.lineKey}`, h]));
    const variants = await variantRefs(tx, tenantId, [
      ...links.map((l) => l.variantId).filter((v): v is string => v !== null),
      ...holds.map((h) => h.variantId),
    ]);
    return lines.map(({ order, stored }) => ({
      order,
      lines: stored.map((s): TikTokOrderLine => {
        const link = linkBy.get(linkKey(order.connectionId, s.externalSkuId));
        const hold = holdBy.get(`${order.id}|${s.key}`);
        // A line that already holds stock goes against the variant it was held on; otherwise against its link.
        const variantId = hold?.variantId ?? link?.variantId ?? null;
        const variant = variantId ? (variants.get(variantId) ?? null) : null;
        return {
          key: s.key,
          externalSkuId: s.externalSkuId,
          sellerSku: s.sellerSku,
          productName: s.productName,
          quantity: s.quantity,
          unitPriceMinor: Number(s.unitPriceMinor),
          variant,
          mapped: variant !== null,
          hold: hold?.state ?? null,
          skuLinkId: link?.id ?? null,
        };
      }),
    }));
  }

  private summary(
    row: OrderRow & { connection: { shopName: string } },
    lines: TikTokOrderLine[],
  ): TikTokOrderSummary {
    return {
      id: row.id,
      connectionId: row.connectionId,
      shopName: row.connection.shopName,
      region: row.region,
      externalOrderId: row.externalOrderId,
      status: row.status,
      onHold: row.onHold,
      statusUpdatedAt: row.statusUpdatedAt?.toISOString() ?? null,
      createdAtTiktok: row.createdAtTiktok?.toISOString() ?? null,
      currency: row.currency,
      currencyExponent: row.currencyExponent,
      totalMinor: minor(row.totalMinor),
      unitCount: lines.reduce((n, l) => n + l.quantity, 0),
      stockState: row.stockState,
      attention: row.attention === 'cancelled_after_shipping' ? row.attention : null,
      unmappedLineCount: lines.filter((l) => !l.mapped && l.hold === null).length,
      mock: row.mock,
    };
  }

  async list(auth: AuthContext, query: TikTokOrderQuery): Promise<TikTokOrderPage> {
    const q = query;
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.tikTokOrder.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(q.status ? { status: normalizeTikTokStatus(q.status) } : {}),
          ...(q.stockState ? { stockState: q.stockState } : {}),
          ...(q.connectionId ? { connectionId: q.connectionId } : {}),
          ...(q.attention === true ? { attention: { not: null } } : {}),
          ...(q.attention === false ? { attention: null } : {}),
          ...(cursor
            ? {
                OR: [
                  { statusUpdatedAt: { lt: cursor.createdAt } },
                  { statusUpdatedAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        include: { connection: { select: { shopName: true } } },
        orderBy: [{ statusUpdatedAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const views = await this.lineViews(tx, auth.tenantId, page);
      const last = page.at(-1);
      const grouped = await tx.tikTokOrder.groupBy({
        by: ['stockState'],
        where: { tenantId: auth.tenantId },
        _count: { _all: true },
      });
      const counts = Object.fromEntries(
        ['none', 'reserved', 'shipped', 'released', 'needs_mapping', 'stock_short'].map((k) => [
          k,
          0,
        ]),
      );
      for (const g of grouped) counts[g.stockState] = g._count._all;
      return {
        mode: this.runtime.mode,
        items: views.map((v, i) => this.summary(page[i]!, v.lines)),
        nextCursor:
          rows.length > q.limit && last
            ? encodeCursor(last.statusUpdatedAt ?? last.createdAt, last.id)
            : null,
        counts,
      };
    });
  }

  async get(auth: AuthContext, id: string): Promise<TikTokOrder> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const row = await tx.tikTokOrder.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { connection: { select: { shopName: true } } },
      });
      if (!row) throw ApiError.notFound('Order not found');
      const [view] = await this.lineViews(tx, auth.tenantId, [row]);
      return {
        ...this.summary(row, view!.lines),
        mode: this.runtime.mode,
        subtotalMinor: minor(row.subtotalMinor),
        sellerDiscountMinor: minor(row.sellerDiscountMinor),
        platformDiscountMinor: minor(row.platformDiscountMinor),
        shippingMinor: minor(row.shippingMinor),
        taxMinor: minor(row.taxMinor),
        fulfilmentType: row.fulfilmentType,
        lines: view!.lines,
      };
    });
  }
}
