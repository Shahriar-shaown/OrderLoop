import { Injectable } from '@nestjs/common';
import type { Dashboard, DashboardPeriod, OrderStatus } from '@orderloop/contracts';
import { ORDER_STATUS_VALUES } from '@orderloop/contracts';
import { Database } from '@orderloop/db';
import { can } from '@orderloop/domain';
import type { AuthContext } from '../common/endpoint.js';

const DAYS: Record<DashboardPeriod, number> = { today: 1, '7d': 7, '30d': 30 };

/** Calendar day (YYYY-MM-DD) of an instant in a time zone. */
const dayIn = (tz: string, at: Date): string => at.toLocaleDateString('en-CA', { timeZone: tz });

/** Add whole days to a YYYY-MM-DD date (pure date arithmetic, no time zone involved). */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type ProfitLines = {
  lines: number;
  with_cost: number;
  revenue: bigint;
  cost: bigint;
  orders: number;
};

/** Cost and profit are finance data: the caller only gets them with `finance:read` (see `get`). */
function profitOf(l: ProfitLines): NonNullable<Dashboard['profit']> {
  const revenue = Number(l.revenue);
  const cost = Number(l.cost);
  return l.lines > 0 && l.with_cost === l.lines
    ? {
        available: true as const,
        kind: 'estimate' as const,
        basis:
          'Item revenue minus the cost price recorded on each line, for delivered orders in this period. Leaves out order discounts, delivery charges, courier fees, returns and taxes.',
        revenueMinor: revenue,
        costMinor: cost,
        grossProfitMinor: revenue - cost,
        deliveredOrders: l.orders,
        lines: l.lines,
      }
    : {
        available: false as const,
        reason:
          l.lines === 0
            ? 'No delivered orders in this period yet.'
            : `${l.lines - l.with_cost} of ${l.lines} delivered order lines have no cost price, so profit cannot be worked out. Add cost prices to your products.`,
        linesWithCost: l.with_cost,
        lines: l.lines,
      };
}

@Injectable()
export class DashboardService {
  constructor(private readonly db: Database) {}

  get(auth: AuthContext, period: DashboardPeriod): Promise<Dashboard> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: auth.tenantId },
        select: { timezone: true },
      });
      const timezone = tenant?.timezone ?? 'Asia/Dhaka';
      const now = new Date();
      const to = dayIn(timezone, now);
      const from = addDays(to, -(DAYS[period] - 1));
      const t = auth.tenantId;
      // The period is whole calendar days in the business's own time zone: [from 00:00, day after `to` 00:00).

      const statusRows = await tx.$queryRaw<
        { status: OrderStatus; n: number; total: bigint; cod: bigint }[]
      >`
        SELECT status, count(*)::int AS n, COALESCE(sum(total_minor), 0) AS total, COALESCE(sum(cod_amount_minor), 0) AS cod
        FROM orders
        WHERE tenant_id = ${t}::uuid
          AND created_at >= (${from}::date)::timestamp AT TIME ZONE ${timezone}
          AND created_at <  ((${to}::date) + 1)::timestamp AT TIME ZONE ${timezone}
        GROUP BY status`;
      const byStatus = Object.fromEntries(ORDER_STATUS_VALUES.map((s) => [s, 0])) as Record<
        OrderStatus,
        number
      >;
      let total = 0;
      let ordered = 0;
      let orderedCount = 0;
      let delivered = 0;
      let codOut = 0;
      for (const r of statusRows) {
        byStatus[r.status] = r.n;
        total += r.n;
        if (r.status !== 'cancelled') {
          ordered += Number(r.total);
          orderedCount += r.n;
        }
        if (r.status === 'delivered') delivered += Number(r.total);
        if (r.status === 'shipped' || r.status === 'in_transit') codOut += Number(r.cod);
      }
      const finished = byStatus.delivered + byStatus.delivery_failed + byStatus.returned;

      const open = await tx.order.groupBy({
        by: ['status'],
        where: {
          tenantId: t,
          status: {
            in: [
              'pending_confirmation',
              'confirmed',
              'ready_to_ship',
              'delivery_failed',
              'return_requested',
            ],
          },
        },
        _count: { _all: true },
      });
      const openBy = (s: string) => open.find((r) => r.status === s)?._count._all ?? 0;

      const daily = await tx.$queryRaw<{ date: string; orders: number; ordered: bigint }[]>`
        SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
               count(o.id) FILTER (WHERE o.status <> 'cancelled')::int AS orders,
               COALESCE(sum(o.total_minor) FILTER (WHERE o.status <> 'cancelled'), 0) AS ordered
        FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS d(day)
        LEFT JOIN orders o
          ON o.tenant_id = ${t}::uuid
         AND (o.created_at AT TIME ZONE ${timezone})::date = d.day::date
        GROUP BY d.day
        ORDER BY d.day`;

      const low = await tx.$queryRaw<
        {
          variant_id: string;
          sku: string;
          product_name: string;
          variant_name: string;
          reorder_point: number;
          available: bigint;
        }[]
      >`
        SELECT v.id AS variant_id, v.sku, p.name AS product_name, v.name AS variant_name, v.reorder_point,
               COALESCE(SUM(l.on_hand), 0) - COALESCE(SUM(l.reserved), 0) AS available
        FROM product_variants v
        JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
        LEFT JOIN stock_levels l ON l.tenant_id = v.tenant_id AND l.variant_id = v.id
        WHERE v.tenant_id = ${t}::uuid AND v.archived_at IS NULL AND p.status = 'ACTIVE' AND v.reorder_point > 0
        GROUP BY v.id, p.name
        HAVING COALESCE(SUM(l.on_hand), 0) - COALESCE(SUM(l.reserved), 0) <= v.reorder_point
        ORDER BY COALESCE(SUM(l.on_hand), 0) - COALESCE(SUM(l.reserved), 0), v.sku
        LIMIT 500`;

      const [lines] = await tx.$queryRaw<ProfitLines[]>`
        SELECT count(i.id)::int AS lines,
               (count(i.id) FILTER (WHERE i.cost_minor IS NOT NULL))::int AS with_cost,
               COALESCE(sum(i.line_total_minor) FILTER (WHERE i.cost_minor IS NOT NULL), 0) AS revenue,
               COALESCE(sum(i.quantity::bigint * i.cost_minor) FILTER (WHERE i.cost_minor IS NOT NULL), 0) AS cost,
               count(DISTINCT o.id)::int AS orders
        FROM orders o
        JOIN order_items i ON i.tenant_id = o.tenant_id AND i.order_id = o.id
        WHERE o.tenant_id = ${t}::uuid AND o.status = 'delivered'
          AND o.created_at >= (${from}::date)::timestamp AT TIME ZONE ${timezone}
          AND o.created_at <  ((${to}::date) + 1)::timestamp AT TIME ZONE ${timezone}`;

      const history = await tx.orderStatusHistory.findMany({
        where: { tenantId: t },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 12,
        include: { order: { select: { orderNumber: true } } },
      });
      const actorIds = [
        ...new Set(history.map((h) => h.actorUserId).filter((x): x is string => !!x)),
      ];
      const users = actorIds.length
        ? await tx.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true },
          })
        : [];
      const names = new Map(users.map((u) => [u.id, u.name]));

      const l = lines ?? { lines: 0, with_cost: 0, revenue: 0n, cost: 0n, orders: 0 };
      return {
        period,
        from,
        to,
        timezone,
        generatedAt: now.toISOString(),
        orders: { total, byStatus },
        attention: {
          pendingConfirmation: openBy('pending_confirmation'),
          toShip: openBy('confirmed') + openBy('ready_to_ship'),
          deliveryFailed: openBy('delivery_failed'),
          returnsOpen: openBy('return_requested'),
        },
        delivery: {
          inProgress: byStatus.shipped + byStatus.in_transit,
          delivered: byStatus.delivered,
          failed: byStatus.delivery_failed,
          returnsOpen: byStatus.return_requested,
          returned: byStatus.returned,
          successRate: finished > 0 ? byStatus.delivered / finished : null,
        },
        sales: {
          orderedMinor: ordered,
          deliveredMinor: delivered,
          codOutForDeliveryMinor: codOut,
          ordersCounted: orderedCount,
          averageOrderMinor: orderedCount > 0 ? Math.round(ordered / orderedCount) : null,
        },
        daily: daily.map((d) => ({
          date: d.date,
          orders: d.orders,
          orderedMinor: Number(d.ordered),
        })),
        lowStock: {
          count: low.length,
          items: low.slice(0, 5).map((r) => ({
            variantId: r.variant_id,
            sku: r.sku,
            productName: r.product_name,
            variantName: r.variant_name,
            available: Number(r.available),
            reorderPoint: r.reorder_point,
          })),
        },
        profit: can(auth.role, 'finance:read') ? profitOf(l) : null,
        recentActivity: history.map((h) => ({
          id: h.id,
          at: h.createdAt.toISOString(),
          orderId: h.orderId,
          orderNumber: h.order.orderNumber,
          fromStatus: h.fromStatus,
          toStatus: h.toStatus,
          actorName: h.actorUserId ? (names.get(h.actorUserId) ?? null) : null,
          reason: h.reason,
        })),
      };
    });
  }
}
