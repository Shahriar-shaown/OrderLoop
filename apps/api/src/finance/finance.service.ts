import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  CreateCostBody,
  Discrepancy as DiscrepancyDto,
  FinanceFigure,
  FinanceSummary,
  ManualCost as ManualCostDto,
  OutstandingCod,
  OutstandingRow,
} from '@orderloop/contracts';
import { Database, isUniqueViolation, Prisma, type Tx } from '@orderloop/db';
import { calculateProfit, cashPosition, type OrderStatusName } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { evaluate } from './discrepancies.js';
import { discrepancyDto } from './settlements.service.js';

const dayIn = (tz: string, at: Date): string => at.toLocaleDateString('en-CA', { timeZone: tz });
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: bigint | number | null | undefined): number => Number(v ?? 0);

/** Statuses of a courier shipment that can carry real money. */
const LIVE_SHIPMENT = [
  'booked',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'partial_delivered',
  'delivery_failed',
  'on_hold',
  'returning',
  'returned',
  'unknown',
];

const costDto = (
  c: Prisma.ManualCostGetPayload<{ include: { order: { select: { orderNumber: true } } } }>,
): ManualCostDto => ({
  id: c.id,
  kind: c.kind,
  amountMinor: c.amountMinor,
  incurredOn: c.incurredOn.toISOString().slice(0, 10),
  orderId: c.orderId,
  orderNumber: c.order?.orderNumber ?? null,
  note: c.note,
  voidedAt: c.voidedAt?.toISOString() ?? null,
  voidReason: c.voidReason,
  createdAt: c.createdAt.toISOString(),
});

@Injectable()
export class FinanceService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ---- discrepancies -------------------------------------------------------------------------------------------------

  listDiscrepancies(
    auth: AuthContext,
    status?: 'open' | 'resolved' | 'waived',
  ): Promise<DiscrepancyDto[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.discrepancy.findMany({
        where: { tenantId: auth.tenantId, ...(status ? { status } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 500,
        include: { order: { select: { orderNumber: true } } },
      });
      return rows.map(discrepancyDto);
    });
  }

  resolveDiscrepancy(
    auth: AuthContext,
    id: string,
    body: { action: 'resolve' | 'waive'; note: string },
    ip: string | null,
  ): Promise<DiscrepancyDto> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM discrepancies WHERE tenant_id = ${auth.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      if (!locked[0]) throw ApiError.notFound('Discrepancy not found');
      const d = await tx.discrepancy.findFirstOrThrow({ where: { id, tenantId: auth.tenantId } });
      if (d.status !== 'open')
        throw new ApiError(409, 'conflict', 'This discrepancy is already closed.');
      // Only a shortfall can be accepted as a loss: that is the one case where the money simply did not arrive.
      if (body.action === 'waive' && d.type !== 'short_paid')
        throw new ApiError(
          409,
          'conflict',
          'Only a shortfall can be waived. Other differences must be resolved by correcting the records.',
        );
      const updated = await tx.discrepancy.update({
        where: { id },
        data: {
          status: body.action === 'waive' ? 'waived' : 'resolved',
          resolution: body.note,
          resolvedAt: new Date(),
          resolvedById: auth.userId,
          closedActualMinor: d.actualMinor,
        },
        include: { order: { select: { orderNumber: true } } },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action:
          body.action === 'waive' ? 'finance.discrepancy_waived' : 'finance.discrepancy_resolved',
        targetType: 'discrepancy',
        targetId: id,
        metadata: {
          type: d.type,
          expectedMinor: d.expectedMinor,
          actualMinor: d.actualMinor,
          note: body.note,
        },
        ip,
      });
      return discrepancyDto(updated);
    });
  }

  /** Re-evaluate every order and line a statement has touched against the orders as they are now. */
  recheck(auth: AuthContext) {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const orders = await tx.settlementItem.findMany({
        where: { tenantId: auth.tenantId, orderId: { not: null } },
        select: { orderId: true },
        distinct: ['orderId'],
      });
      const items = await tx.settlementItem.findMany({
        where: { tenantId: auth.tenantId, matchStatus: { notIn: ['duplicate'] } },
        select: { id: true },
      });
      // Discrepancies that mention an order with no matched cash left are included so they can close.
      const open = await tx.discrepancy.findMany({
        where: { tenantId: auth.tenantId, status: 'open', orderId: { not: null } },
        select: { orderId: true },
      });
      const r = await evaluate(tx, this.audit, auth.tenantId, {
        orderIds: [
          ...orders.map((o) => o.orderId as string),
          ...open.map((o) => o.orderId as string),
        ],
        itemIds: items.map((i) => i.id),
      });
      return { checked: r.checked, opened: r.opened, closed: r.closed };
    });
  }

  // ---- outstanding COD -----------------------------------------------------------------------------------------------

  async outstandingIn(tx: Tx, tenantId: string): Promise<OutstandingCod> {
    // Every order that has a real (not simulated) courier shipment that could carry money, with the cash its statements report.
    const rows = await tx.$queryRaw<
      {
        order_id: string;
        order_number: number;
        status: OrderStatusName;
        cod: number;
        shipment_id: string;
        provider: OutstandingRow['provider'];
        simulated: boolean;
        collected: bigint;
        delivered_at: Date | null;
      }[]
    >`
      SELECT o.id AS order_id, o.order_number, o.status, o.cod_amount_minor AS cod,
             s.id AS shipment_id, s.provider, s.simulated,
             COALESCE((SELECT sum(i.collected_minor) FROM settlement_items i
                       WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id AND i.match_status = 'matched' AND i.kind = 'cod'), 0) AS collected,
             (SELECT max(h.created_at) FROM order_status_history h WHERE h.tenant_id = o.tenant_id AND h.order_id = o.id AND h.to_status = 'delivered') AS delivered_at
      FROM orders o
      JOIN LATERAL (
        SELECT * FROM shipments sh
        WHERE sh.tenant_id = o.tenant_id AND sh.order_id = o.id AND sh.status::text = ANY(${LIVE_SHIPMENT})
        ORDER BY sh.attempt DESC LIMIT 1
      ) s ON true
      WHERE o.tenant_id = ${tenantId}::uuid AND o.status IN ('delivered', 'shipped', 'in_transit') AND s.simulated = false`;

    const now = Date.now();
    let expected = 0;
    let collected = 0;
    let outstanding = 0;
    let onTheWay = 0;
    const byProvider = new Map<string, { orders: number; outstandingMinor: number }>();
    const out: OutstandingRow[] = [];
    for (const r of rows) {
      const c = num(r.collected);
      const pos = cashPosition({ status: r.status, codAmountMinor: r.cod, collectedMinor: c });
      if (r.status === 'delivered') {
        expected += r.cod;
        collected += Math.min(c, r.cod);
        outstanding += pos.outstandingMinor;
        if (pos.outstandingMinor > 0) {
          const p = byProvider.get(r.provider) ?? { orders: 0, outstandingMinor: 0 };
          p.orders++;
          p.outstandingMinor += pos.outstandingMinor;
          byProvider.set(r.provider, p);
          out.push({
            orderId: r.order_id,
            orderNumber: r.order_number,
            provider: r.provider,
            shipmentId: r.shipment_id,
            simulated: r.simulated,
            deliveredAt: r.delivered_at?.toISOString() ?? null,
            ageDays: r.delivered_at
              ? Math.max(0, Math.floor((now - r.delivered_at.getTime()) / 86_400_000))
              : null,
            expectedMinor: r.cod,
            collectedMinor: c,
            outstandingMinor: pos.outstandingMinor,
            state: pos.state,
          });
        }
      } else {
        onTheWay += Math.max(0, r.cod - c);
      }
    }
    out.sort(
      (a, b) =>
        (a.deliveredAt ?? '').localeCompare(b.deliveredAt ?? '') || a.orderNumber - b.orderNumber,
    );

    const untracked = await tx.$queryRaw<{ n: bigint; cod: bigint }[]>`
      SELECT count(*) AS n, COALESCE(sum(o.cod_amount_minor), 0) AS cod
      FROM orders o
      WHERE o.tenant_id = ${tenantId}::uuid AND o.status = 'delivered' AND o.cod_amount_minor > 0
        AND NOT EXISTS (SELECT 1 FROM shipments sh WHERE sh.tenant_id = o.tenant_id AND sh.order_id = o.id
                        AND sh.status::text = ANY(${LIVE_SHIPMENT}) AND sh.simulated = false)`;
    const LIMIT = 500;
    return {
      asOf: new Date().toISOString(),
      deliveredExpectedMinor: expected,
      deliveredCollectedMinor: collected,
      outstandingMinor: outstanding,
      onTheWayMinor: onTheWay,
      untrackedDeliveredCount: num(untracked[0]?.n),
      untrackedDeliveredMinor: num(untracked[0]?.cod),
      byProvider: [...byProvider.entries()].map(([provider, v]) => ({
        provider: provider as OutstandingRow['provider'],
        ...v,
      })),
      rows: out.slice(0, LIMIT),
      truncated: out.length > LIMIT,
    };
  }

  getOutstanding(auth: AuthContext): Promise<OutstandingCod> {
    return this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      this.outstandingIn(tx, auth.tenantId),
    );
  }

  // ---- summary -------------------------------------------------------------------------------------------------------

  getSummary(
    auth: AuthContext,
    q: { from?: string | undefined; to?: string | undefined },
  ): Promise<FinanceSummary> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const t = auth.tenantId;
      const tenant = await tx.tenant.findUnique({ where: { id: t }, select: { timezone: true } });
      const tz = tenant?.timezone ?? 'Asia/Dhaka';
      const to = q.to ?? dayIn(tz, new Date());
      const from = q.from ?? addDays(to, -29);
      if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to)
        throw new ApiError(400, 'validation_failed', 'Request validation failed', [
          { path: 'query.from', message: 'The period must start on or before it ends' },
        ]);
      if (
        new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime() >
        366 * 86_400_000
      )
        throw new ApiError(400, 'validation_failed', 'Request validation failed', [
          { path: 'query.to', message: 'The period can be at most a year' },
        ]);

      // Whole calendar days in the business's own time zone: [from 00:00, day after `to` 00:00).
      const [sales] = await tx.$queryRaw<
        {
          n: number;
          total: bigint;
          advance: bigint;
          cancelled_n: number;
          cancelled_total: bigint;
        }[]
      >`
        SELECT count(*) FILTER (WHERE status <> 'cancelled')::int AS n,
               COALESCE(sum(total_minor) FILTER (WHERE status <> 'cancelled'), 0) AS total,
               COALESCE(sum(advance_paid_minor) FILTER (WHERE status <> 'cancelled'), 0) AS advance,
               count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_n,
               COALESCE(sum(total_minor) FILTER (WHERE status = 'cancelled'), 0) AS cancelled_total
        FROM orders
        WHERE tenant_id = ${t}::uuid
          AND created_at >= (${from}::date)::timestamp AT TIME ZONE ${tz}
          AND created_at <  ((${to}::date) + 1)::timestamp AT TIME ZONE ${tz}`;

      // Revenue: orders that are delivered now, in the period they were delivered. Returned and cancelled orders are not revenue.
      const [rev] = await tx.$queryRaw<
        {
          n: number;
          goods: bigint;
          delivery: bigint;
          lines: number;
          lines_costed: number;
          cogs: bigint;
        }[]
      >`
        WITH d AS (
          SELECT o.id, o.subtotal_minor, o.discount_minor, o.delivery_charge_minor
          FROM orders o
          JOIN LATERAL (SELECT max(h.created_at) AS at FROM order_status_history h
                        WHERE h.tenant_id = o.tenant_id AND h.order_id = o.id AND h.to_status = 'delivered') dh ON true
          WHERE o.tenant_id = ${t}::uuid AND o.status = 'delivered'
            AND dh.at >= (${from}::date)::timestamp AT TIME ZONE ${tz}
            AND dh.at <  ((${to}::date) + 1)::timestamp AT TIME ZONE ${tz})
        SELECT (SELECT count(*) FROM d)::int AS n,
               COALESCE((SELECT sum(subtotal_minor - discount_minor) FROM d), 0) AS goods,
               COALESCE((SELECT sum(delivery_charge_minor) FROM d), 0) AS delivery,
               (SELECT count(*) FROM order_items i JOIN d ON d.id = i.order_id WHERE i.tenant_id = ${t}::uuid)::int AS lines,
               (SELECT count(*) FROM order_items i JOIN d ON d.id = i.order_id WHERE i.tenant_id = ${t}::uuid AND i.cost_minor IS NOT NULL)::int AS lines_costed,
               COALESCE((SELECT sum(i.quantity::bigint * i.cost_minor) FROM order_items i JOIN d ON d.id = i.order_id
                         WHERE i.tenant_id = ${t}::uuid AND i.cost_minor IS NOT NULL), 0) AS cogs`;

      // Statements, by the date printed on each line. Duplicates and lines a person set aside are left out.
      const [stm] = await tx.$queryRaw<
        {
          matched_collected: bigint;
          matched_net: bigint;
          unmatched_collected: bigint;
          delivery: bigint;
          cod_fee: bigint;
          ret: bigint;
          other: bigint;
        }[]
      >`
        SELECT COALESCE(sum(collected_minor) FILTER (WHERE match_status = 'matched'), 0) AS matched_collected,
               COALESCE(sum(net_minor) FILTER (WHERE match_status = 'matched'), 0) AS matched_net,
               COALESCE(sum(collected_minor) FILTER (WHERE match_status IN ('unmatched', 'ambiguous')), 0) AS unmatched_collected,
               COALESCE(sum(delivery_charge_minor), 0) AS delivery, COALESCE(sum(cod_fee_minor), 0) AS cod_fee,
               COALESCE(sum(return_charge_minor), 0) AS ret, COALESCE(sum(other_deduction_minor), 0) AS other
        FROM settlement_items
        WHERE tenant_id = ${t}::uuid AND match_status NOT IN ('duplicate', 'ignored')
          AND item_date >= ${from}::date AND item_date <= ${to}::date`;

      const manual = await tx.manualCost.groupBy({
        by: ['kind'],
        where: {
          tenantId: t,
          voidedAt: null,
          incurredOn: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        },
        _sum: { amountMinor: true },
      });
      const manualTotal = manual.reduce((n, m) => n + (m._sum.amountMinor ?? 0), 0);

      const waived = await tx.$queryRaw<{ lost: bigint }[]>`
        SELECT COALESCE(sum(expected_minor - actual_minor), 0) AS lost
        FROM discrepancies
        WHERE tenant_id = ${t}::uuid AND status = 'waived' AND type = 'short_paid'
          AND resolved_at >= (${from}::date)::timestamp AT TIME ZONE ${tz}
          AND resolved_at <  ((${to}::date) + 1)::timestamp AT TIME ZONE ${tz}`;
      const writtenOff = num(waived[0]?.lost);

      const outstanding = await this.outstandingIn(tx, t);

      const courier = {
        delivery: num(stm?.delivery),
        codFee: num(stm?.cod_fee),
        ret: num(stm?.ret),
        other: num(stm?.other),
      };
      const courierTotal = courier.delivery + courier.codFee + courier.ret + courier.other;
      const lines = num(rev?.lines);
      const costKnown = lines === num(rev?.lines_costed);
      const cogs = costKnown ? num(rev?.cogs) : null;
      const profit = calculateProfit({
        goodsRevenueMinor: num(rev?.goods),
        deliveryBilledMinor: num(rev?.delivery),
        cogsMinor: cogs,
        courierChargesMinor: courierTotal,
        manualCostsMinor: manualTotal,
        writtenOffMinor: writtenOff,
      });

      const fig = (f: FinanceFigure): FinanceFigure => f;
      const figures: FinanceFigure[] = [
        fig({
          key: 'sales',
          group: 'sales',
          label: 'Sales (orders placed)',
          amountMinor: num(sales?.total),
          source: 'orders',
          note: `${num(sales?.n)} order(s) created in the period, not cancelled, at their full total including delivery charge. Placing an order is not revenue and not cash.`,
        }),
        fig({
          key: 'cancelled',
          group: 'sales',
          label: 'Cancelled orders (left out of sales)',
          amountMinor: num(sales?.cancelled_total),
          source: 'orders',
          note: `${num(sales?.cancelled_n)} order(s) created in the period and cancelled. They are never revenue.`,
        }),
        fig({
          key: 'revenue_goods',
          group: 'revenue',
          label: 'Revenue: goods delivered',
          amountMinor: num(rev?.goods),
          source: 'orders',
          note: `${num(rev?.n)} order(s) delivered in the period and still delivered: item prices less discounts. Returned and cancelled orders are not counted. Delivered is not the same as paid.`,
        }),
        fig({
          key: 'revenue_delivery',
          group: 'revenue',
          label: 'Revenue: delivery charges billed to customers',
          amountMinor: num(rev?.delivery),
          source: 'orders',
          note: 'Delivery charges on those delivered orders, as billed to the customer.',
        }),
        fig({
          key: 'cash_collected',
          group: 'cash',
          label: 'Cash collected by couriers (on statements, matched to orders)',
          amountMinor: num(stm?.matched_collected),
          source: 'settlements',
          note: 'What courier statements dated in the period say they collected from customers, for lines tied to an order. It is what the courier reports, not proof it reached your bank.',
        }),
        fig({
          key: 'cash_net',
          group: 'cash',
          label: 'Paid out to you after courier charges (on statements)',
          amountMinor: num(stm?.matched_net),
          source: 'settlements',
          note: 'Collected cash less the charges the courier kept, for matched lines.',
        }),
        fig({
          key: 'cash_unmatched',
          group: 'cash',
          label: 'Cash reported on lines not tied to an order',
          amountMinor: num(stm?.unmatched_collected),
          source: 'settlements',
          note: 'Statement lines that are unmatched or in doubt. Not counted as collected until a person ties them to an order.',
        }),
        fig({
          key: 'cash_advance',
          group: 'cash',
          label: 'Advance payments on orders placed',
          amountMinor: num(sales?.advance),
          source: 'orders',
          note: 'Advance amounts your team recorded on orders. Not verified against any bank or wallet.',
        }),
        fig({
          key: 'outstanding_cod',
          group: 'outstanding',
          label: 'Outstanding COD (as of now)',
          amountMinor: outstanding.outstandingMinor,
          source: 'derived',
          note: 'COD on delivered orders with a real courier shipment, less the cash the statements report for them. Not limited to the period. Delivery alone never reduces it.',
        }),
        fig({
          key: 'cod_on_the_way',
          group: 'outstanding',
          label: 'COD still with couriers (not yet due)',
          amountMinor: outstanding.onTheWayMinor,
          source: 'derived',
          note: 'COD on orders that are shipped or in transit. Not owed until delivered.',
        }),
        ...(cogs !== null
          ? [
              fig({
                key: 'cogs',
                group: 'expenses',
                label: 'Cost of goods delivered',
                amountMinor: cogs,
                source: 'catalog_costs',
                note: 'Cost price recorded on each delivered order line at the time of sale, times quantity.',
              }),
            ]
          : []),
        fig({
          key: 'courier_delivery',
          group: 'expenses',
          label: 'Courier delivery charges',
          amountMinor: courier.delivery,
          source: 'settlements',
          note: 'Delivery charges on statement lines dated in the period, including lines not yet tied to an order.',
        }),
        fig({
          key: 'courier_cod_fee',
          group: 'expenses',
          label: 'Courier COD fees',
          amountMinor: courier.codFee,
          source: 'settlements',
          note: 'Cash-handling fees on statement lines dated in the period.',
        }),
        fig({
          key: 'courier_return',
          group: 'expenses',
          label: 'Courier return charges',
          amountMinor: courier.ret,
          source: 'settlements',
          note: 'Charges for returned parcels, on statement lines dated in the period.',
        }),
        fig({
          key: 'courier_other',
          group: 'expenses',
          label: 'Other courier deductions',
          amountMinor: courier.other,
          source: 'settlements',
          note: 'Other deductions and adjustments on statement lines dated in the period.',
        }),
        fig({
          key: 'manual_costs',
          group: 'expenses',
          label: 'Other costs you recorded',
          amountMinor: manualTotal,
          source: 'manual_costs',
          note: 'Costs entered by hand (packaging, advertising and so on), by the date incurred. Voided costs are left out.',
        }),
        fig({
          key: 'cod_written_off',
          group: 'expenses',
          label: 'COD shortfalls written off',
          amountMinor: writtenOff,
          source: 'manual_costs',
          note: 'COD a courier did not pay, which a person accepted as a loss in the period.',
        }),
        ...(profit.estimatedProfitMinor !== null
          ? [
              fig({
                key: 'estimated_profit',
                group: 'profit',
                label: 'Estimated profit',
                amountMinor: profit.estimatedProfitMinor,
                source: 'derived',
                note: 'Revenue (goods + delivery billed) minus cost of goods, courier charges, recorded costs and written-off shortfalls. An estimate: it follows the records, not the bank.',
              }),
            ]
          : []),
      ];
      const caveats = [
        'Sales, revenue, cash collected, outstanding COD, expenses and profit are different things and are never added together.',
        'Revenue is dated by delivery; courier charges and recorded costs by the date on the statement or cost. Their periods can differ at the edges.',
        ...(outstanding.untrackedDeliveredCount
          ? [
              `${outstanding.untrackedDeliveredCount} delivered order(s) with COD have no real courier shipment, so no statement can ever confirm their cash. They are not in outstanding COD.`,
            ]
          : []),
        ...(manualTotal === 0 && courierTotal === 0
          ? ['No costs are recorded for this period, so profit before costs is shown as-is.']
          : []),
      ];
      return {
        from,
        to,
        timezone: tz,
        figures,
        estimatedProfitMinor: profit.estimatedProfitMinor,
        profitWithheldReason: profit.withheldReason,
        caveats,
      };
    });
  }

  // ---- manual costs --------------------------------------------------------------------------------------------------

  listCosts(
    auth: AuthContext,
    q: { from?: string | undefined; to?: string | undefined },
  ): Promise<ManualCostDto[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.manualCost.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(q.from || q.to
            ? {
                incurredOn: {
                  ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
                  ...(q.to ? { lte: new Date(`${q.to}T00:00:00Z`) } : {}),
                },
              }
            : {}),
        },
        orderBy: [{ incurredOn: 'desc' }, { createdAt: 'desc' }],
        take: 500,
        include: { order: { select: { orderNumber: true } } },
      });
      return rows.map(costDto);
    });
  }

  createCost(auth: AuthContext, body: CreateCostBody, ip: string | null): Promise<ManualCostDto> {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          body.kind,
          body.amountMinor,
          body.incurredOn,
          body.orderId ?? null,
          body.note,
        ]),
      )
      .digest('hex');
    const include = { order: { select: { orderNumber: true } } } as const;
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const replay = await tx.manualCost.findFirst({
        where: { tenantId: auth.tenantId, idempotencyKey: body.idempotencyKey },
        include,
      });
      if (replay) {
        if (replay.requestHash !== requestHash)
          throw new ApiError(
            409,
            'idempotency_conflict',
            'This idempotency key was already used for a different cost.',
          );
        return costDto(replay);
      }
      if (new Date(`${body.incurredOn}T00:00:00Z`).toISOString().slice(0, 10) !== body.incurredOn)
        throw new ApiError(400, 'validation_failed', 'Request validation failed', [
          { path: 'body.incurredOn', message: 'That date does not exist' },
        ]);
      if (
        body.orderId &&
        !(await tx.order.findFirst({
          where: { id: body.orderId, tenantId: auth.tenantId },
          select: { id: true },
        }))
      )
        throw ApiError.notFound('Order not found');
      try {
        const created = await tx.manualCost.create({
          data: {
            tenantId: auth.tenantId,
            kind: body.kind,
            amountMinor: body.amountMinor,
            incurredOn: new Date(`${body.incurredOn}T00:00:00Z`),
            orderId: body.orderId ?? null,
            note: body.note,
            idempotencyKey: body.idempotencyKey,
            requestHash,
            createdById: auth.userId,
          },
          include,
        });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'finance.cost_created',
          targetType: 'manual_cost',
          targetId: created.id,
          metadata: { kind: body.kind, amountMinor: body.amountMinor },
          ip,
        });
        return costDto(created);
      } catch (error) {
        if (isUniqueViolation(error))
          throw new ApiError(
            409,
            'conflict',
            'This cost is being recorded right now. Check the list before trying again.',
          );
        throw error;
      }
    });
  }

  voidCost(
    auth: AuthContext,
    id: string,
    reason: string,
    ip: string | null,
  ): Promise<ManualCostDto> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM manual_costs WHERE tenant_id = ${auth.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      if (!locked[0]) throw ApiError.notFound('Cost not found');
      const c = await tx.manualCost.findFirstOrThrow({ where: { id, tenantId: auth.tenantId } });
      if (c.voidedAt) throw new ApiError(409, 'conflict', 'This cost is already voided.');
      const updated = await tx.manualCost.update({
        where: { id },
        data: { voidedAt: new Date(), voidedById: auth.userId, voidReason: reason },
        include: { order: { select: { orderNumber: true } } },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'finance.cost_voided',
        targetType: 'manual_cost',
        targetId: id,
        metadata: { amountMinor: c.amountMinor, reason },
        ip,
      });
      return costDto(updated);
    });
  }
}
