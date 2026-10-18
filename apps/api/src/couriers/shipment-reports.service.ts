import { Injectable } from '@nestjs/common';
import type {
  ShipmentQuery,
  ShipmentRow,
  ShipmentRowPage,
  ShipmentSummary,
} from '@orderloop/contracts';
import { Database, Prisma } from '@orderloop/db';
import type { AuthContext } from '../common/endpoint.js';

const num = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const like = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
/** Statuses of a parcel that exists at a courier (a booking that failed or was cancelled is not one). */
const LIVE = [
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
const ON_THE_WAY = ['picked_up', 'in_transit', 'out_for_delivery'];
const OPEN = ['booked', 'picked_up', 'in_transit', 'out_for_delivery', 'on_hold'];
const ANY = (list: string[]) => Prisma.sql`ANY(${list}::text[])`;

/** Read-only views over shipments for the Couriers screen: a searchable list and the figures above it. */
@Injectable()
export class ShipmentReportsService {
  constructor(private readonly db: Database) {}

  async list(auth: AuthContext, q: ShipmentQuery): Promise<ShipmentRowPage> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const t = auth.tenantId;
      const tenant = await tx.tenant.findUnique({ where: { id: t }, select: { timezone: true } });
      const tz = tenant?.timezone ?? 'Asia/Dhaka';
      const base: Prisma.Sql[] = [Prisma.sql`s.tenant_id = ${t}::uuid`];
      if (q.provider) base.push(Prisma.sql`s.provider = ${q.provider}::"CourierProvider"`);
      if (q.codOnly) base.push(Prisma.sql`s.cod_amount_minor > 0`);
      if (q.from)
        base.push(Prisma.sql`s.created_at >= (${q.from}::date)::timestamp AT TIME ZONE ${tz}`);
      if (q.to)
        base.push(Prisma.sql`s.created_at < ((${q.to}::date) + 1)::timestamp AT TIME ZONE ${tz}`);
      if (q.q) {
        const text = like(q.q.toLowerCase());
        const number = /^#?(?:OL-)?(\d{1,9})$/i.exec(q.q.trim());
        base.push(Prisma.sql`(lower(s.provider_reference) LIKE ${text} OR lower(COALESCE(s.provider_consignment_id, '')) LIKE ${text}
          OR lower(COALESCE(s.tracking_code, '')) LIKE ${text} OR lower(c.name) LIKE ${text}
          ${number ? Prisma.sql`OR o.order_number = ${Number(number[1])}` : Prisma.empty})`);
      }
      const baseWhere = Prisma.join(base, ' AND ');
      const where = q.status?.length
        ? Prisma.sql`${baseWhere} AND s.status::text = ANY(${q.status}::text[])`
        : baseWhere;
      const from = Prisma.sql`FROM shipments s
        JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
        JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id`;

      const total =
        (
          await tx.$queryRaw<{ n: number }[]>(
            Prisma.sql`SELECT count(*)::int AS n ${from} WHERE ${where}`,
          )
        )[0]?.n ?? 0;
      const rows = await tx.$queryRaw<
        {
          id: string;
          order_id: string;
          order_number: number;
          customer_name: string;
          provider: ShipmentRow['provider'];
          environment: ShipmentRow['environment'];
          simulated: boolean;
          status: ShipmentRow['status'];
          provider_status: string | null;
          provider_consignment_id: string | null;
          provider_reference: string;
          tracking_code: string | null;
          cod_amount_minor: number;
          delivery_fee_minor: number | null;
          booked_at: Date | null;
          updated_at: Date;
        }[]
      >(Prisma.sql`
        SELECT s.id, s.order_id, o.order_number, c.name AS customer_name, s.provider, s.environment, s.simulated, s.status,
               s.provider_status, s.provider_consignment_id, s.provider_reference, s.tracking_code, s.cod_amount_minor,
               s.delivery_fee_minor, s.booked_at, COALESCE(s.last_event_at, s.updated_at) AS updated_at
        ${from} WHERE ${where}
        ORDER BY COALESCE(s.last_event_at, s.updated_at) DESC, s.id DESC
        LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`);
      const counts = await tx.$queryRaw<{ status: string; n: number }[]>(
        Prisma.sql`SELECT s.status::text AS status, count(*)::int AS n ${from} WHERE ${baseWhere} GROUP BY s.status`,
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          orderId: r.order_id,
          orderNumber: r.order_number,
          customerName: r.customer_name,
          provider: r.provider,
          environment: r.environment,
          simulated: r.simulated,
          status: r.status,
          providerStatus: r.provider_status,
          consignmentId: r.provider_consignment_id,
          reference: r.provider_reference,
          trackingCode: r.tracking_code,
          codAmountMinor: r.cod_amount_minor,
          deliveryFeeMinor: r.delivery_fee_minor,
          bookedAt: r.booked_at?.toISOString() ?? null,
          updatedAt: r.updated_at.toISOString(),
        })),
        total,
        page: q.page,
        pages: Math.max(1, Math.ceil(total / q.limit)),
        statusCounts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      };
    });
  }

  async summary(auth: AuthContext): Promise<ShipmentSummary> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const t = auth.tenantId;
      const tenant = await tx.tenant.findUnique({ where: { id: t }, select: { timezone: true } });
      const tz = tenant?.timezone ?? 'Asia/Dhaka';
      const [k] = await tx.$queryRaw<
        {
          today: number;
          awaiting: number;
          on_the_way: number;
          delayed: number;
          delivered: number;
          returned: number;
          cod: bigint;
          cod_n: number;
        }[]
      >(Prisma.sql`
        SELECT
          (count(*) FILTER (WHERE s.status::text = ${ANY(LIVE)} AND (s.created_at AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date))::int AS today,
          (count(*) FILTER (WHERE s.status = 'booked'))::int AS awaiting,
          (count(*) FILTER (WHERE s.status::text = ${ANY(ON_THE_WAY)}))::int AS on_the_way,
          (count(*) FILTER (WHERE s.status::text = ${ANY(OPEN)} AND COALESCE(s.booked_at, s.created_at) < now() - interval '3 days'))::int AS delayed,
          (count(*) FILTER (WHERE s.status = 'delivered' AND COALESCE(s.last_event_at, s.updated_at) >= now() - interval '7 days'))::int AS delivered,
          (count(*) FILTER (WHERE s.status = 'returned' AND COALESCE(s.last_event_at, s.updated_at) >= now() - interval '7 days'))::int AS returned,
          COALESCE(sum(s.cod_amount_minor) FILTER (WHERE s.status::text = ${ANY(ON_THE_WAY)} AND s.simulated = false), 0) AS cod,
          (count(*) FILTER (WHERE s.status::text = ${ANY(ON_THE_WAY)} AND s.simulated = false AND s.cod_amount_minor > 0))::int AS cod_n
        FROM shipments s WHERE s.tenant_id = ${t}::uuid`);
      const providers = await tx.$queryRaw<
        {
          provider: ShipmentSummary['providers'][number]['provider'];
          simulated: boolean;
          n: number;
          delivered: number;
          failed: number;
          returned: number;
          avg_days: number | null;
        }[]
      >(Prisma.sql`
        SELECT s.provider, bool_or(s.simulated) AS simulated, count(*)::int AS n,
               (count(*) FILTER (WHERE s.status = 'delivered'))::int AS delivered,
               (count(*) FILTER (WHERE s.status = 'delivery_failed'))::int AS failed,
               (count(*) FILTER (WHERE s.status = 'returned'))::int AS returned,
               avg(extract(epoch FROM (s.last_event_at - s.booked_at)) / 86400.0) FILTER (WHERE s.status = 'delivered' AND s.booked_at IS NOT NULL AND s.last_event_at IS NOT NULL) AS avg_days
        FROM shipments s
        WHERE s.tenant_id = ${t}::uuid AND s.status::text = ${ANY(LIVE)} AND s.created_at >= now() - interval '30 days'
        GROUP BY s.provider ORDER BY s.provider`);
      return {
        recentDays: 7,
        statsDays: 30,
        bookedToday: k?.today ?? 0,
        awaitingPickup: k?.awaiting ?? 0,
        onTheWay: k?.on_the_way ?? 0,
        delayed: k?.delayed ?? 0,
        delivered: k?.delivered ?? 0,
        returned: k?.returned ?? 0,
        codOnTheWayMinor: num(k?.cod),
        codOnTheWayCount: k?.cod_n ?? 0,
        providers: providers.map((p) => {
          const finished = p.delivered + p.failed + p.returned;
          return {
            provider: p.provider,
            simulated: p.simulated,
            shipments: p.n,
            delivered: p.delivered,
            deliveredRate: finished > 0 ? p.delivered / finished : null,
            avgDeliveryDays: p.avg_days === null ? null : Math.round(Number(p.avg_days) * 10) / 10,
          };
        }),
      };
    });
  }
}
