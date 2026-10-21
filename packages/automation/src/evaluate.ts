import type { AutomationKind } from '@orderloop/contracts';
import { MAX_UNCONFIRMED_REMINDERS } from '@orderloop/contracts';
import { Prisma, type Tx } from '@orderloop/db';
import {
  buildCodDiscrepancy,
  buildDelayed,
  buildLowStock,
  buildNewOrder,
  buildNewOrders,
  buildReport,
  buildUnconfirmed,
  currentReportSlot,
  DIGEST_TOP,
  reportWindow,
  type BuiltNotification,
  type ReportMetrics,
} from '@orderloop/domain';

export interface EvalContext {
  tx: Tx;
  tenantId: string;
  ruleId: string;
  runId: string;
  kind: AutomationKind;
  /** The rule's validated config (without `kind`). */
  config: Record<string, unknown>;
  now: Date;
  timezone: string;
  currency: string;
  /** When the rule was last switched on; orders created before it are not announced as new. */
  enabledAt: Date | null;
  slotKey: string;
  /** Set for a NEW_ORDER event job. */
  orderId?: string | undefined;
}

/** What a rule found that is worth telling people about right now. `null`: nothing new. */
export interface Evaluation {
  built: BuiltNotification;
  /** Unique per (recipient, dedupeKey): creating the same notification twice is impossible whatever happens. */
  dedupeKey: string;
}

/** Look-back of the new-order catch-up scan, which covers an event that never got queued. */
export const NEW_ORDER_CATCHUP_MS = 30 * 60_000;
/** Safety cap on what one scan looks at; a digest names the top few anyway. */
const SCAN_LIMIT = 2000;

// ---- episode state ----------------------------------------------------------------------------------------------------

/**
 * Try to claim subjects that have no episode yet. Only the one transaction that inserts the row gets it back, so two
 * evaluations running at once can never both announce the same thing. The claim commits with the notifications that announce it.
 */
async function claimNew(ctx: EvalContext, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await ctx.tx.$queryRaw<{ subject_id: string }[]>`
    INSERT INTO automation_state (tenant_id, rule_id, subject_id, count, last_notified_at)
    SELECT ${ctx.tenantId}::uuid, ${ctx.ruleId}::uuid, s, 1, ${ctx.now}::timestamptz FROM unnest(${ids}::text[]) AS s
    ON CONFLICT (rule_id, subject_id) DO NOTHING
    RETURNING subject_id`;
  return new Set(rows.map((r) => r.subject_id));
}

/** End the episodes of subjects that no longer match (stock recovered, order confirmed): the rule is armed again for them. */
async function rearm(ctx: EvalContext, stillMatching: string[]): Promise<void> {
  await ctx.tx.$executeRaw`
    DELETE FROM automation_state
    WHERE tenant_id = ${ctx.tenantId}::uuid AND rule_id = ${ctx.ruleId}::uuid
      AND NOT (subject_id = ANY(${stillMatching}::text[]))`;
}

const num = (v: bigint | number | null | undefined): number => Number(v ?? 0);

// ---- LOW_STOCK --------------------------------------------------------------------------------------------------------

/**
 * A variant is low when its available stock (on hand minus reserved, summed over locations) is at or below its threshold:
 * its own reorder point (`basis: reorder_point`; a reorder point of 0 means that variant never alerts) or one fixed number
 * for every variant. Out-of-stock variants are included only with `includeZeroStock`. Archived variants and variants of
 * archived products never count.
 *
 * A variant that is low and has been announced stays quiet until it is no longer low (its episode ends), and is announced
 * again the next time it dips.
 */
async function lowStock(ctx: EvalContext): Promise<Evaluation | null> {
  const fixed = ctx.config.basis === 'fixed';
  const includeZero = ctx.config.includeZeroStock !== false;
  const threshold = fixed
    ? Prisma.sql`${Number(ctx.config.fixedQuantity ?? 0)}::int`
    : Prisma.sql`reorder_point`;
  const rows = await ctx.tx.$queryRaw<
    { id: string; sku: string; product_name: string; available: bigint }[]
  >(Prisma.sql`
    SELECT s.id, s.sku, s.product_name, s.available FROM (
      SELECT v.id, v.sku, p.name AS product_name, v.reorder_point,
             COALESCE(SUM(l.on_hand), 0)::bigint - COALESCE(SUM(l.reserved), 0)::bigint AS available
      FROM product_variants v
      JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
      LEFT JOIN stock_levels l ON l.tenant_id = v.tenant_id AND l.variant_id = v.id
      WHERE v.tenant_id = ${ctx.tenantId}::uuid AND v.archived_at IS NULL AND p.status = 'ACTIVE'
        ${fixed ? Prisma.empty : Prisma.sql`AND v.reorder_point > 0`}
      GROUP BY v.id, p.name
    ) s
    WHERE (s.available <= 0 AND ${includeZero}::boolean) OR (s.available > 0 AND s.available <= ${threshold})
    ORDER BY s.available, s.sku
    LIMIT ${SCAN_LIMIT}`);
  const ids = rows.map((r) => r.id);
  await rearm(ctx, ids);
  const claimed = await claimNew(ctx, ids);
  const fresh = rows.filter((r) => claimed.has(r.id));
  if (fresh.length === 0) return null;
  return {
    built: buildLowStock(
      fresh.slice(0, DIGEST_TOP).map((r) => ({
        variantId: r.id,
        sku: r.sku,
        productName: r.product_name,
        available: num(r.available),
      })),
      fresh.length,
    ),
    dedupeKey: `LOW_STOCK:run:${ctx.runId}`,
  };
}

// ---- NEW_ORDER --------------------------------------------------------------------------------------------------------

/**
 * Event-driven: the API queues `neworder-<orderId>` after an order is created. That job announces exactly that order.
 * A catch-up scan (the five-minute scan of this rule) announces orders created in the last 30 minutes that nobody has
 * announced, which covers an event that was never queued. Both claim the order in `automation_state` first, so an order is
 * announced once whichever gets there first, and never when it was created before the rule was switched on.
 */
async function newOrder(ctx: EvalContext): Promise<Evaluation | null> {
  const since = new Date(
    Math.max(ctx.now.getTime() - NEW_ORDER_CATCHUP_MS, ctx.enabledAt?.getTime() ?? 0),
  );
  if (ctx.orderId) {
    const rows = await ctx.tx.$queryRaw<
      { id: string; order_number: number; source: string; items: number }[]
    >`
      SELECT o.id, o.order_number, o.source::text AS source,
             (SELECT count(*)::int FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id) AS items
      FROM orders o
      WHERE o.tenant_id = ${ctx.tenantId}::uuid AND o.id = ${ctx.orderId}::uuid
        AND o.created_at >= ${ctx.enabledAt ?? new Date(0)}::timestamptz`;
    const order = rows[0];
    if (!order) return null;
    if (!(await claimNew(ctx, [order.id])).has(order.id)) return null;
    return {
      built: buildNewOrder({
        id: order.id,
        orderNumber: order.order_number,
        itemCount: num(order.items),
        source: order.source,
      }),
      dedupeKey: `NEW_ORDER:order:${order.id}`,
    };
  }
  // Catch-up. Old episode rows (a day or two) are dropped so the table does not grow.
  await ctx.tx.$executeRaw`
    DELETE FROM automation_state
    WHERE tenant_id = ${ctx.tenantId}::uuid AND rule_id = ${ctx.ruleId}::uuid
      AND last_notified_at < ${new Date(ctx.now.getTime() - 2 * 86_400_000)}::timestamptz`;
  const rows = await ctx.tx.$queryRaw<{ id: string; order_number: number }[]>`
    SELECT o.id, o.order_number FROM orders o
    WHERE o.tenant_id = ${ctx.tenantId}::uuid AND o.created_at >= ${since}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM automation_state s WHERE s.rule_id = ${ctx.ruleId}::uuid AND s.subject_id = o.id::text)
    ORDER BY o.created_at, o.order_number
    LIMIT ${SCAN_LIMIT}`;
  const claimed = await claimNew(
    ctx,
    rows.map((r) => r.id),
  );
  const fresh = rows.filter((r) => claimed.has(r.id));
  if (fresh.length === 0) return null;
  return {
    built: buildNewOrders(
      fresh.slice(0, DIGEST_TOP).map((r) => ({ id: r.id, orderNumber: r.order_number })),
      fresh.length,
    ),
    dedupeKey: `NEW_ORDER:scan:${ctx.runId}`,
  };
}

// ---- UNCONFIRMED_ORDER ------------------------------------------------------------------------------------------------

/**
 * Orders still in `pending_confirmation` more than `afterMinutes` after they were created. Each is announced once; with
 * `repeatEveryMinutes` it is announced again that long after its last reminder, up to 3 notifications per order in total.
 * An order that is confirmed or cancelled ends its episode.
 */
async function unconfirmed(ctx: EvalContext): Promise<Evaluation | null> {
  const afterMinutes = Number(ctx.config.afterMinutes ?? 60);
  const repeat = ctx.config.repeatEveryMinutes ? Number(ctx.config.repeatEveryMinutes) : null;
  const cutoff = new Date(ctx.now.getTime() - afterMinutes * 60_000);
  const rows = await ctx.tx.$queryRaw<{ id: string; order_number: number }[]>`
    SELECT o.id, o.order_number FROM orders o
    WHERE o.tenant_id = ${ctx.tenantId}::uuid AND o.status = 'pending_confirmation' AND o.created_at <= ${cutoff}::timestamptz
    ORDER BY o.created_at, o.order_number
    LIMIT ${SCAN_LIMIT}`;
  const ids = rows.map((r) => r.id);
  await rearm(ctx, ids);
  const first = await claimNew(ctx, ids);
  const again = new Set<string>();
  if (repeat && ids.length) {
    const repeatCutoff = new Date(ctx.now.getTime() - repeat * 60_000);
    const updated = await ctx.tx.$queryRaw<{ subject_id: string }[]>`
      UPDATE automation_state SET count = count + 1, last_notified_at = ${ctx.now}::timestamptz
      WHERE tenant_id = ${ctx.tenantId}::uuid AND rule_id = ${ctx.ruleId}::uuid AND subject_id = ANY(${ids}::text[])
        AND count < ${MAX_UNCONFIRMED_REMINDERS} AND last_notified_at <= ${repeatCutoff}::timestamptz
      RETURNING subject_id`;
    for (const u of updated) again.add(u.subject_id);
  }
  const fresh = rows.filter((r) => first.has(r.id) || again.has(r.id));
  if (fresh.length === 0) return null;
  return {
    built: buildUnconfirmed(
      fresh.slice(0, DIGEST_TOP).map((r) => ({ id: r.id, orderNumber: r.order_number })),
      fresh.length,
      afterMinutes,
    ),
    dedupeKey: `UNCONFIRMED_ORDER:run:${ctx.runId}`,
  };
}

// ---- DELAYED_ORDER ----------------------------------------------------------------------------------------------------

/**
 * An order is delayed when it has not been delivered `afterHours` after its clock started. The clock starts when the order
 * last entered `confirmed` (statuses confirmed and ready_to_ship: it has not been handed to a courier yet) or `shipped`
 * (statuses shipped, in_transit and delivery_failed: it is on its way or came back). Delivered, cancelled and returned orders
 * are never delayed. Each is announced once; a change of phase (confirmed to shipped) restarts the clock and re-arms it.
 */
async function delayed(ctx: EvalContext): Promise<Evaluation | null> {
  const afterHours = Number(ctx.config.afterHours ?? 48);
  const cutoff = new Date(ctx.now.getTime() - afterHours * 3_600_000);
  const rows = await ctx.tx.$queryRaw<{ id: string; order_number: number }[]>`
    SELECT o.id, o.order_number
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT max(h.created_at) AS since FROM order_status_history h
      WHERE h.tenant_id = o.tenant_id AND h.order_id = o.id
        AND h.to_status = (CASE WHEN o.status IN ('confirmed', 'ready_to_ship') THEN 'confirmed' ELSE 'shipped' END)::"OrderStatus"
    ) c ON true
    WHERE o.tenant_id = ${ctx.tenantId}::uuid
      AND o.status IN ('confirmed', 'ready_to_ship', 'shipped', 'in_transit', 'delivery_failed')
      AND COALESCE(c.since, o.created_at) <= ${cutoff}::timestamptz
    ORDER BY COALESCE(c.since, o.created_at), o.order_number
    LIMIT ${SCAN_LIMIT}`;
  const ids = rows.map((r) => r.id);
  await rearm(ctx, ids);
  const claimed = await claimNew(ctx, ids);
  const fresh = rows.filter((r) => claimed.has(r.id));
  if (fresh.length === 0) return null;
  return {
    built: buildDelayed(
      fresh.slice(0, DIGEST_TOP).map((r) => ({ id: r.id, orderNumber: r.order_number })),
      fresh.length,
      afterHours,
    ),
    dedupeKey: `DELAYED_ORDER:run:${ctx.runId}`,
  };
}

// ---- COD_DISCREPANCY --------------------------------------------------------------------------------------------------

/**
 * Open settlement discrepancies (see finance.md), optionally only those whose difference is at least `minAmountMinor`.
 * Each is announced once while it stays open; resolving or waiving it ends its episode (and it is announced again if it reopens).
 */
async function codDiscrepancy(ctx: EvalContext): Promise<Evaluation | null> {
  const min = Number(ctx.config.minAmountMinor ?? 0);
  const rows = await ctx.tx.$queryRaw<{ id: string; order_number: number | null }[]>`
    SELECT d.id, o.order_number
    FROM discrepancies d
    LEFT JOIN orders o ON o.tenant_id = d.tenant_id AND o.id = d.order_id
    WHERE d.tenant_id = ${ctx.tenantId}::uuid AND d.status = 'open'
      AND (${min}::int <= 0
           OR (d.actual_minor IS NULL AND d.expected_minor IS NULL)
           OR ABS(COALESCE(d.actual_minor, 0) - COALESCE(d.expected_minor, 0)) >= ${min}::int)
    ORDER BY d.created_at, d.id
    LIMIT ${SCAN_LIMIT}`;
  const ids = rows.map((r) => r.id);
  await rearm(ctx, ids);
  const claimed = await claimNew(ctx, ids);
  const fresh = rows.filter((r) => claimed.has(r.id));
  if (fresh.length === 0) return null;
  return {
    built: buildCodDiscrepancy(
      fresh.slice(0, DIGEST_TOP).map((r) => ({ id: r.id, orderNumber: r.order_number })),
      fresh.length,
    ),
    dedupeKey: `COD_DISCREPANCY:run:${ctx.runId}`,
  };
}

// ---- reports ----------------------------------------------------------------------------------------------------------

/** Business-level totals for a window. Revenue is the sum of the totals of orders created in it that were not cancelled. */
export async function reportMetrics(
  tx: Tx,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<ReportMetrics> {
  const [orders] = await tx.$queryRaw<{ n: number; revenue: bigint }[]>`
    SELECT count(*)::int AS n,
           COALESCE(sum(total_minor) FILTER (WHERE status <> 'cancelled'), 0)::bigint AS revenue
    FROM orders WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${from}::timestamptz AND created_at < ${to}::timestamptz`;
  const [moves] = await tx.$queryRaw<{ delivered: number; cancelled: number }[]>`
    SELECT count(DISTINCT order_id) FILTER (WHERE to_status = 'delivered')::int AS delivered,
           count(DISTINCT order_id) FILTER (WHERE to_status = 'cancelled')::int AS cancelled
    FROM order_status_history
    WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${from}::timestamptz AND created_at < ${to}::timestamptz`;
  const [low] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT v.id FROM product_variants v
      JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
      LEFT JOIN stock_levels l ON l.tenant_id = v.tenant_id AND l.variant_id = v.id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.archived_at IS NULL AND p.status = 'ACTIVE' AND v.reorder_point > 0
      GROUP BY v.id HAVING COALESCE(SUM(l.on_hand), 0) - COALESCE(SUM(l.reserved), 0) <= max(v.reorder_point)
    ) x`;
  const [disc] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM discrepancies WHERE tenant_id = ${tenantId}::uuid AND status = 'open'`;
  return {
    orders: orders?.n ?? 0,
    revenueMinor: num(orders?.revenue),
    delivered: moves?.delivered ?? 0,
    cancelled: moves?.cancelled ?? 0,
    lowStock: low?.n ?? 0,
    openDiscrepancies: disc?.n ?? 0,
  };
}

/**
 * Daily: today so far (from local midnight to now). Weekly: the last 7 local days including today. Reports are named by their
 * slot (`daily:2026-03-29`), and the notification's dedupe key is that slot, so a slot is announced once per person however
 * often it is evaluated.
 */
async function report(ctx: EvalContext): Promise<Evaluation | null> {
  const kind = ctx.kind as 'DAILY_REPORT' | 'WEEKLY_REPORT';
  const { localDate } = currentReportSlot(ctx.now, ctx.timezone, kind);
  // A report of a slot is about that slot's own local date even when it runs late (a retry after midnight keeps its date).
  const slotDate = /\d{4}-\d{2}-\d{2}/.exec(ctx.slotKey)?.[0] ?? localDate;
  const win = reportWindow(
    kind,
    kind === 'DAILY_REPORT' ? slotDate : localDate,
    ctx.timezone,
    ctx.now,
  );
  const metrics = await reportMetrics(ctx.tx, ctx.tenantId, win.from, win.to);
  return {
    built: buildReport(kind, { fromDate: win.fromDate, toDate: win.toDate }, metrics, ctx.currency),
    dedupeKey: `report:${ctx.slotKey}`,
  };
}

export const EVALUATORS: Record<AutomationKind, (ctx: EvalContext) => Promise<Evaluation | null>> =
  {
    LOW_STOCK: lowStock,
    NEW_ORDER: newOrder,
    UNCONFIRMED_ORDER: unconfirmed,
    DELAYED_ORDER: delayed,
    COD_DISCREPANCY: codDiscrepancy,
    DAILY_REPORT: report,
    WEEKLY_REPORT: report,
  };
