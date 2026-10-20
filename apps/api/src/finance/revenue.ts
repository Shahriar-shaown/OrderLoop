import { Prisma, type Tx } from '@orderloop/db';
import { revenueMinor } from '@orderloop/domain';

const num = (v: bigint | number | null | undefined): number => Number(v ?? 0);

/**
 * THE set of orders that count as revenue in a period: orders that are delivered now, dated by their latest delivery, in
 * whole calendar days of the business's time zone. Returned and cancelled orders are not revenue. The dashboard, the
 * finance summary and analytics all select from this, so their figures for one period agree.
 * Columns: id, source, goods_minor (item prices less all discounts), delivery_minor (delivery billed), day.
 * Revenue is `goods + delivery` (`revenueMinor` in the domain).
 */
export function deliveredOrdersSql(
  tenantId: string,
  tz: string,
  from: string,
  to: string,
  source?: string,
): Prisma.Sql {
  const src = source ? Prisma.sql`AND o.source = ${source}::"OrderSource"` : Prisma.empty;
  return Prisma.sql`
    SELECT o.id, o.source, o.subtotal_minor - o.discount_minor AS goods_minor,
           o.delivery_charge_minor AS delivery_minor, to_char(dh.at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day
    FROM orders o
    JOIN LATERAL (SELECT max(h.created_at) AS at FROM order_status_history h
                  WHERE h.tenant_id = o.tenant_id AND h.order_id = o.id AND h.to_status = 'delivered') dh ON true
    WHERE o.tenant_id = ${tenantId}::uuid AND o.status = 'delivered' ${src}
      AND dh.at >= (${from}::date)::timestamp AT TIME ZONE ${tz}
      AND dh.at <  ((${to}::date) + 1)::timestamp AT TIME ZONE ${tz}`;
}

export interface DeliveredTotals {
  orders: number;
  goodsMinor: number;
  deliveryMinor: number;
  revenueMinor: number;
  lines: number;
  costedLines: number;
  /** Cost of goods, or null when a delivered line has no cost price (so it is unknown, not zero). */
  cogsMinor: number | null;
}

/** Revenue and cost of goods of a period's delivered orders, for the dashboard and the finance summary. */
export async function deliveredTotals(
  tx: Tx,
  tenantId: string,
  tz: string,
  from: string,
  to: string,
): Promise<DeliveredTotals> {
  const [r] = await tx.$queryRaw<
    {
      n: number;
      goods: bigint;
      delivery: bigint;
      lines: number;
      costed: number;
      cogs: bigint;
    }[]
  >`
    WITH d AS (${deliveredOrdersSql(tenantId, tz, from, to)})
    SELECT (SELECT count(*) FROM d)::int AS n,
           COALESCE((SELECT sum(goods_minor) FROM d), 0) AS goods,
           COALESCE((SELECT sum(delivery_minor) FROM d), 0) AS delivery,
           (SELECT count(*) FROM order_items i JOIN d ON d.id = i.order_id WHERE i.tenant_id = ${tenantId}::uuid)::int AS lines,
           (SELECT count(*) FROM order_items i JOIN d ON d.id = i.order_id WHERE i.tenant_id = ${tenantId}::uuid AND i.cost_minor IS NOT NULL)::int AS costed,
           COALESCE((SELECT sum(i.quantity::bigint * i.cost_minor) FROM order_items i JOIN d ON d.id = i.order_id
                     WHERE i.tenant_id = ${tenantId}::uuid AND i.cost_minor IS NOT NULL), 0) AS cogs`;
  const goods = num(r?.goods);
  const delivery = num(r?.delivery);
  const lines = num(r?.lines);
  const costed = num(r?.costed);
  return {
    orders: num(r?.n),
    goodsMinor: goods,
    deliveryMinor: delivery,
    revenueMinor: revenueMinor(goods, delivery),
    lines,
    costedLines: costed,
    cogsMinor: lines === costed ? num(r?.cogs) : null,
  };
}
