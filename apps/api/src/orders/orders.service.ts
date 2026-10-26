import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  AddressFields,
  BulkResult,
  BulkStatusBody,
  ChangeStatusBody,
  CreateOrderBody,
  DuplicateCheckBody,
  OrderDetail,
  OrderHistoryEntry,
  OrderPage,
  OrderQuery,
  OrderStatus,
  PotentialDuplicate,
  Role,
  UpdateOrderBody,
} from '@orderloop/contracts';
import { Database, isUniqueViolation, Prisma, type Tx } from '@orderloop/db';
import {
  calculateOrderTotals,
  can,
  canTransition,
  editScope,
  normalizeBdPhone,
  OrderTotalsError,
  REASON_REQUIRED,
  stockEffect,
  type OrderTotals,
} from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { AutomationEvents } from '../automation/automation-events.service.js';
import { ApiError } from '../common/api-error.js';
import { stable } from '../common/stable.js';
import type { AuthContext } from '../common/endpoint.js';
import { evaluate as evaluateDiscrepancies } from '../finance/discrepancies.js';
import { StockRunner } from '../inventory/inventory.service.js';
import { CustomersService } from './customers.service.js';
import { liveShipmentOf } from './live-shipment.js';
import { toDetail, toSummary, type OrderRow, type SummaryRow } from './order.mapper.js';
import {
  afterCursor,
  decodeOrderCursor,
  encodeOrderCursor,
  orderBy,
  orderWhere,
  sortColumn,
} from './order-query.js';
import {
  describeReturn,
  planReturn,
  releaseOrder,
  reserveOrder,
  restockOrder,
  shipOrder,
  type LineRef,
} from './order-stock.js';

/** Statuses only a person with `orders:close` may set by hand. */
const MANUAL_CLOSE: readonly OrderStatus[] = ['delivered', 'returned'];

const validation = (path: string, message: string) =>
  new ApiError('validation_failed', 'Request validation failed', [{ path, message }]);

const orderInclude = {
  items: { orderBy: { position: 'asc' as const } },
  customer: { select: { id: true, name: true, phone: true } },
} satisfies Prisma.OrderInclude;

interface MoneyLine {
  variantId: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
}
interface MoneyFigures {
  subtotalMinor: number;
  discountMinor: number;
  deliveryChargeMinor: number;
  advancePaidMinor: number;
  totalMinor: number;
  codAmountMinor: number;
}

/** What an order edit records of the money: the figures and the lines (by variant), never a name, phone or address. */
const moneySnapshot = (figures: MoneyFigures, lines: readonly MoneyLine[]) => ({
  subtotalMinor: figures.subtotalMinor,
  discountMinor: figures.discountMinor,
  deliveryChargeMinor: figures.deliveryChargeMinor,
  advancePaidMinor: figures.advancePaidMinor,
  totalMinor: figures.totalMinor,
  codAmountMinor: figures.codAmountMinor,
  items: lines.map((l) => ({
    variantId: l.variantId,
    quantity: l.quantity,
    unitPriceMinor: l.unitPriceMinor,
    discountMinor: l.discountMinor,
  })),
});

/** Where a recent order counts as a possible repeat of a new one. */
const DUPLICATE_WINDOW_MS = 72 * 3_600_000;
const JUST_PLACED_MS = 10 * 60_000;

@Injectable()
export class OrdersService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly runner: StockRunner,
    private readonly customers: CustomersService,
    private readonly automation: AutomationEvents,
  ) {}

  // ---- reading -------------------------------------------------------------------------------------------------------

  private async history(tx: Tx, tenantId: string, orderId: string): Promise<OrderHistoryEntry[]> {
    const rows = await tx.orderStatusHistory.findMany({
      where: { tenantId, orderId },
      // Ids are time-ordered UUIDv7, so they break ties between rows created in the same millisecond.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
    const users = actorIds.length
      ? await tx.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      reason: r.reason,
      actorUserId: r.actorUserId,
      actorName: r.actorUserId ? (names.get(r.actorUserId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async loadDetail(tx: Tx, tenantId: string, id: string): Promise<OrderDetail> {
    const order = await tx.order.findFirst({ where: { id, tenantId }, include: orderInclude });
    // Another business's order id is invisible under row-level security: not found, same as a missing one.
    if (!order) throw ApiError.notFound('Order not found');
    return toDetail(order as unknown as OrderRow, await this.history(tx, tenantId, id));
  }

  get(auth: AuthContext, id: string): Promise<OrderDetail> {
    return this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      this.loadDetail(tx, auth.tenantId, id),
    );
  }

  /** The business's own time zone decides what "today" means in a date filter. */
  private async timezone(tx: Tx, tenantId: string): Promise<string> {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    return t?.timezone ?? 'Asia/Dhaka';
  }

  async list(auth: AuthContext, query: OrderQuery, forCustomer?: string): Promise<OrderPage> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const tz = await this.timezone(tx, auth.tenantId);
      const filters = { ...query, ...(forCustomer ? { customerId: forCustomer } : {}) };
      const where = orderWhere(auth.tenantId, filters, tz);
      const cursor = query.cursor ? decodeOrderCursor(query.cursor) : undefined;
      if (query.cursor && !cursor) throw validation('query.cursor', 'Invalid cursor');
      const paged = cursor
        ? Prisma.sql`${where} AND ${afterCursor(query.sort, query.dir, cursor)}`
        : where;

      const rows = await tx.$queryRaw<SummaryRow[]>(Prisma.sql`
        SELECT o.id, o.order_number, o.status, o.source, o.customer_id, c.name AS customer_name,
               o.ship_phone AS phone, o.ship_district AS district, o.total_minor, o.cod_amount_minor, o.created_at,
               (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i
                 WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id) AS item_count,
               (SELECT i.product_name || CASE WHEN i.variant_name <> '' THEN ' ' || i.variant_name ELSE '' END
                  FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id ORDER BY i.position LIMIT 1) AS first_item,
               (SELECT i.quantity FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id ORDER BY i.position LIMIT 1) AS first_qty,
               (SELECT count(*) FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id) AS line_count,
               sh.provider AS courier_provider, sh.status AS courier_status, sh.simulated AS courier_simulated,
               COALESCE((SELECT sum(si.collected_minor) FROM settlement_items si
                          WHERE si.tenant_id = o.tenant_id AND si.order_id = o.id AND si.match_status = 'matched' AND si.kind = 'cod'), 0)
               + COALESCE((SELECT sum(cr.amount_minor) FROM cod_receipts cr
                            WHERE cr.tenant_id = o.tenant_id AND cr.order_id = o.id AND cr.voided_at IS NULL), 0) AS collected,
               ${sortColumn(query.sort)} AS sv
        FROM orders o JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
        LEFT JOIN LATERAL (
          SELECT s.provider, s.status, s.simulated FROM shipments s
          WHERE s.tenant_id = o.tenant_id AND s.order_id = o.id AND s.status NOT IN ('booking_failed', 'cancelled')
          ORDER BY s.attempt DESC LIMIT 1) sh ON true
        WHERE ${paged}
        ORDER BY ${orderBy(query.sort, query.dir)}
        LIMIT ${query.limit + 1}`);
      const counted = await tx.$queryRaw<{ total: number }[]>(Prisma.sql`
        SELECT count(*)::int AS total
        FROM orders o JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
        WHERE ${where}`);

      // How many orders each status has under the same filters (but not the status filter), for the status chips.
      const withoutStatus = { ...filters, status: undefined };
      const byStatus = await tx.$queryRaw<{ status: string; n: number }[]>(Prisma.sql`
        SELECT o.status::text AS status, count(*)::int AS n
        FROM orders o JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
        WHERE ${orderWhere(auth.tenantId, withoutStatus, tz)}
        GROUP BY o.status`);
      const statusCounts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));

      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toSummary),
        total: counted[0]?.total ?? 0,
        statusCounts,
        nextCursor:
          rows.length > query.limit && last
            ? encodeOrderCursor({
                v: last.sv instanceof Date ? last.sv.toISOString() : (last.sv as string | number),
                id: last.id,
              })
            : null,
      };
    });
  }

  // ---- totals and lines ----------------------------------------------------------------------------------------------

  private totalsOrThrow(
    input: Parameters<typeof calculateOrderTotals>[0],
    pathPrefix = 'body',
  ): OrderTotals {
    try {
      return calculateOrderTotals(input);
    } catch (error) {
      if (error instanceof OrderTotalsError)
        throw validation(`${pathPrefix}.${error.field}`, error.message);
      throw error;
    }
  }

  /**
   * Check each requested variant exists in this business and can be sold; return the snapshot to store on the line.
   * On an edit, `current` holds the order's existing lines: a variant already on the order keeps its price and cost
   * unless a new price is sent, so editing never re-prices a line from today's catalogue.
   */
  private async resolveItems(
    tx: Tx,
    tenantId: string,
    items: CreateOrderBody['items'],
    current: readonly {
      variantId: string;
      unitPriceMinor: number;
      costMinor: number | null;
    }[] = [],
  ) {
    const existing = new Map(current.map((l) => [l.variantId, l]));
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (seen.has(item.variantId))
        throw validation(`body.items.${i}.variantId`, 'This item appears more than once');
      seen.add(item.variantId);
    });
    const variants = await tx.productVariant.findMany({
      where: { tenantId, id: { in: items.map((i) => i.variantId) } },
      include: { product: { select: { name: true, status: true } } },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    return items.map((item, i) => {
      const v = byId.get(item.variantId);
      if (!v) throw validation(`body.items.${i}.variantId`, 'Item not found');
      const kept = existing.get(v.id);
      if (v.archivedAt || v.product.status === 'ARCHIVED')
        throw validation(`body.items.${i}.variantId`, `${v.sku} is archived and cannot be ordered`);
      return {
        variantId: v.id,
        sku: v.sku,
        productName: v.product.name,
        variantName: v.name,
        costMinor: kept ? kept.costMinor : v.costMinor,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor ?? kept?.unitPriceMinor ?? v.priceMinor,
        discountMinor: item.discountMinor ?? 0,
      };
    });
  }

  private async nextOrderNumber(tx: Tx, tenantId: string): Promise<number> {
    // One row per tenant, locked until this transaction ends: numbers are unique and ascending, and a rolled-back order
    // gives its number back.
    const rows = await tx.$queryRaw<{ n: number }[]>`
      INSERT INTO order_counters (tenant_id, next_number) VALUES (${tenantId}::uuid, 1002)
      ON CONFLICT (tenant_id) DO UPDATE SET next_number = order_counters.next_number + 1
      RETURNING next_number - 1 AS n`;
    return rows[0]!.n;
  }

  // ---- create --------------------------------------------------------------------------------------------------------

  /**
   * Create an order inside the CALLER'S transaction, with the same idempotency rule as `create` (an existing order under the
   * same key is returned as it is; the same key with another body is 409). For flows that must do something else in the very
   * same transaction (the Meta draft link). Call `announce` after the transaction commits.
   */
  async createWithin(
    tx: Tx,
    auth: AuthContext,
    body: CreateOrderBody,
    ip: string | null,
  ): Promise<{ order: OrderDetail; created: boolean }> {
    const { idempotencyKey, ...rest } = body;
    const requestHash = createHash('sha256').update(stable(rest)).digest('hex');
    const existing = await tx.order.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: auth.tenantId, idempotencyKey } },
      select: { id: true, requestHash: true },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ApiError(
          'idempotency_conflict',
          'This idempotency key was already used for a different order',
        );
      return { order: await this.loadDetail(tx, auth.tenantId, existing.id), created: false };
    }
    return { order: await this.createInTx(tx, auth, body, requestHash, ip), created: true };
  }

  /** Tell automation about a committed new order (never inside the transaction). A repeat queues the same job id, so once. */
  announce(tenantId: string, orderId: string): void {
    void this.automation.orderCreated(tenantId, orderId);
  }

  async create(auth: AuthContext, body: CreateOrderBody, ip: string | null): Promise<OrderDetail> {
    const attempt = () =>
      this.db.withContext(
        { tenantId: auth.tenantId, userId: auth.userId },
        async (tx) => (await this.createWithin(tx, auth, body, ip)).order,
      );
    let order: OrderDetail;
    try {
      order = await attempt();
    } catch (error) {
      // Two requests with one key raced: the loser's insert hit the unique index and rolled back. Now the key exists.
      if (!isUniqueViolation(error, 'idempotency_key')) throw error;
      order = await attempt();
    }
    // Tell automation after the order is committed (never inside the transaction). A replay queues the same job id, so once.
    this.announce(auth.tenantId, order.id);
    return order;
  }

  private async createInTx(
    tx: Tx,
    auth: AuthContext,
    body: CreateOrderBody,
    requestHash: string,
    ip: string | null,
  ): Promise<OrderDetail> {
    const tenantId = auth.tenantId;
    // Customer: a saved one, or matched on phone number (never duplicated).
    const customerId = body.customerId
      ? await this.customers.requireId(tx, tenantId, body.customerId, 'body.customerId')
      : await this.customers.findOrCreateByPhone(tx, tenantId, body.customer!);

    // Delivery address: copied onto the order, so later edits to the address book never rewrite it.
    let ship = body.address;
    if (body.addressId) {
      const saved = await tx.customerAddress.findFirst({
        where: { id: body.addressId, tenantId, customerId },
      });
      if (!saved) throw validation('body.addressId', 'Address not found for this customer');
      ship = {
        recipientName: saved.recipientName,
        phone: saved.phone,
        line1: saved.line1,
        area: saved.area,
        district: saved.district,
        division: saved.division as never,
        postalCode: saved.postalCode,
      };
    } else if (body.saveAddress !== false) {
      // `body` is typed by what a client may send (any spelling of the division); validation has already normalised it.
      await this.customers.saveAddressIfNew(tx, tenantId, customerId, ship as AddressFields);
    }
    const shipping = ship!;

    const lines = await this.resolveItems(tx, tenantId, body.items);
    const totals = this.totalsOrThrow({
      lines,
      discountMinor: body.discountMinor ?? 0,
      deliveryChargeMinor: body.deliveryChargeMinor ?? 0,
      advancePaidMinor: body.advancePaidMinor ?? 0,
    });

    const orderNumber = await this.nextOrderNumber(tx, tenantId);
    const order = await tx.order.create({
      data: {
        tenantId,
        orderNumber,
        customerId,
        source: body.source ?? 'other',
        sourceReference: body.sourceReference ?? null,
        notes: body.notes ?? null,
        shipName: shipping.recipientName,
        shipPhone: shipping.phone,
        shipLine1: shipping.line1,
        shipArea: shipping.area,
        shipDistrict: shipping.district,
        shipDivision: shipping.division,
        shipPostalCode: shipping.postalCode ?? null,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: totals.discountMinor,
        deliveryChargeMinor: totals.deliveryChargeMinor,
        totalMinor: totals.totalMinor,
        advancePaidMinor: totals.advancePaidMinor,
        codAmountMinor: totals.codAmountMinor,
        idempotencyKey: body.idempotencyKey,
        requestHash,
        createdById: auth.userId,
      },
    });
    await tx.orderItem.createMany({
      data: lines.map((l, position) => ({
        tenantId,
        orderId: order.id,
        position,
        variantId: l.variantId,
        sku: l.sku,
        productName: l.productName,
        variantName: l.variantName,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
        discountMinor: l.discountMinor,
        lineTotalMinor: totals.lineTotalsMinor[position]!,
        costMinor: l.costMinor,
      })),
    });
    await tx.orderStatusHistory.create({
      data: {
        tenantId,
        orderId: order.id,
        fromStatus: null,
        toStatus: 'pending_confirmation',
        reason: 'Order created',
        actorUserId: auth.userId,
      },
    });
    await this.audit.record(tx, {
      tenantId,
      actorUserId: auth.userId,
      action: 'order.created',
      targetType: 'order',
      targetId: order.id,
      metadata: {
        orderNumber,
        source: order.source,
        totalMinor: totals.totalMinor,
        items: lines.length,
      },
      ip,
    });

    if (body.confirm)
      await this.moveInTx(
        tx,
        auth,
        order.id,
        { status: 'confirmed' },
        ip,
        'Confirmed when created',
      );
    return this.loadDetail(tx, tenantId, order.id);
  }

  // ---- status changes ------------------------------------------------------------------------------------------------

  changeStatus(
    auth: AuthContext,
    id: string,
    body: ChangeStatusBody,
    ip: string | null,
  ): Promise<OrderDetail> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      await this.moveInTx(tx, auth, id, body, ip);
      return this.loadDetail(tx, auth.tenantId, id);
    });
  }

  /**
   * Move one order to `body.status` inside the caller's transaction. The order row is locked first and the current status
   * is read under that lock, so two requests (a double click, two staff, a bulk action overlapping a single one) take
   * turns: the second finds the status already changed. Asking for the status an order is already in changes nothing and
   * is not an error, which is what makes cancel and return safe to repeat.
   */
  async moveInTx(
    tx: Tx,
    /**
     * `userId` is null when the courier, not a person, causes the move (a delivery update): the history then shows no
     * actor, and no permission applies. A person's move needs their `role`.
     */
    auth: { tenantId: string; userId: string | null; role?: Role },
    id: string,
    body: Pick<ChangeStatusBody, 'status' | 'reason' | 'returnedItems' | 'ifVersion'>,
    ip: string | null,
    defaultReason?: string,
  ): Promise<void> {
    const tenantId = auth.tenantId;
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (!locked[0]) throw ApiError.notFound('Order not found');
    const order = await tx.order.findFirstOrThrow({
      where: { id, tenantId },
      include: { items: true },
    });

    const to = body.status;
    const from = order.status as OrderStatus;
    if (from === to) return; // already there: nothing to do, nothing to record

    // Delivered and returned decide revenue and put stock back, so by hand they are for people trusted to close an order.
    // The courier's own news (no person) is the evidence that makes them safe for anyone else.
    if (
      auth.userId !== null &&
      MANUAL_CLOSE.includes(to) &&
      !(auth.role && can(auth.role, 'orders:close'))
    )
      throw ApiError.forbidden(
        `Only an owner, admin or manager can mark an order ${to} by hand. Ask one of them, or let the courier's update do it.`,
      );

    if (body.ifVersion !== undefined && body.ifVersion !== order.version)
      throw new ApiError(
        'version_conflict',
        'This order was changed by someone else. Reload it and try again.',
      );
    if (!canTransition(from, to))
      throw new ApiError(
        'invalid_transition',
        `An order that is ${from.replace(/_/g, ' ')} cannot become ${to.replace(/_/g, ' ')}`,
      );
    if (to === 'cancelled') {
      // An order cannot be cancelled while a parcel for it exists (or may exist) at a courier: that parcel would still be delivered and collected on.
      const live = await liveShipmentOf(tx, tenantId, id);
      if (live)
        throw new ApiError(
          'shipment_conflict',
          live.status === 'booking' || live.status === 'booking_uncertain'
            ? 'A courier booking for this order is unconfirmed. Settle it on the order page before cancelling.'
            : 'This order has a live courier shipment. Cancel the shipment first, then cancel the order.',
        );
    }
    let reason = body.reason?.trim() || defaultReason;
    let returned: ReturnType<typeof describeReturn> | undefined;
    if (REASON_REQUIRED.includes(to) && !body.reason?.trim())
      throw validation('body.reason', 'Say why (at least 3 characters)');

    const actor = { tenantId, userId: auth.userId };
    const lines: LineRef[] = order.items.map((i) => ({
      id: i.id,
      variantId: i.variantId,
      sku: i.sku,
      quantity: i.quantity,
      reservationId: i.reservationId,
    }));

    switch (stockEffect(from, to)) {
      case 'reserve': {
        const reservations = await reserveOrder(tx, this.runner, actor, id, lines);
        for (const [itemId, reservationId] of reservations)
          await tx.orderItem.update({ where: { id: itemId }, data: { reservationId } });
        break;
      }
      case 'release':
        await releaseOrder(tx, actor, id, lines, reason ?? 'Order cancelled');
        break;
      case 'ship':
        await shipOrder(tx, actor, id, lines);
        break;
      case 'restock': {
        const plan = planReturn(lines, body.returnedItems ?? []);
        returned = describeReturn(lines, plan);
        // The history keeps what came back, so a partial return reads as one later.
        const short = returned.filter((r) => r.returned < r.sent);
        if (short.length)
          reason = `${reason ?? 'Order returned'} (partial: ${short.map((r) => `${r.sku} ${r.returned}/${r.sent}`).join(', ')})`;
        await restockOrder(tx, actor, id, lines, plan, reason ?? 'Order returned');
        break;
      }
      case 'none':
        break;
    }

    await tx.order.update({ where: { id }, data: { status: to, version: { increment: 1 } } });
    await tx.orderStatusHistory.create({
      data: {
        tenantId,
        orderId: id,
        fromStatus: from,
        toStatus: to,
        reason: reason ?? null,
        actorUserId: auth.userId,
      },
    });
    await this.audit.record(tx, {
      tenantId,
      actorUserId: auth.userId,
      action: to === 'cancelled' ? 'order.cancelled' : 'order.status_changed',
      targetType: 'order',
      targetId: id,
      metadata: { orderNumber: order.orderNumber, from, to, ...(returned ? { returned } : {}) },
      ip,
    });
    // Whether cash the courier reported is early, short or fine depends on the order's status, so look again now that it changed.
    if (
      await tx.settlementItem.findFirst({ where: { tenantId, orderId: id }, select: { id: true } })
    )
      await evaluateDiscrepancies(tx, this.audit, tenantId, { orderIds: [id] });
  }

  /** Several orders, each in its own transaction, so one that cannot move does not stop the rest. */
  async bulkChangeStatus(
    auth: AuthContext,
    body: BulkStatusBody,
    ip: string | null,
  ): Promise<BulkResult> {
    const ids = [...new Set(body.orderIds)];
    const results: BulkResult['results'] = [];
    for (const orderId of ids) {
      try {
        const detail = await this.changeStatus(
          auth,
          orderId,
          { status: body.status, ...(body.reason ? { reason: body.reason } : {}) },
          ip,
        );
        results.push({
          orderId,
          orderNumber: detail.orderNumber,
          ok: true,
          status: detail.status,
          error: null,
        });
      } catch (error) {
        const known = error instanceof ApiError;
        const current = await this.db
          .withContext({ tenantId: auth.tenantId }, (tx) =>
            tx.order.findFirst({
              where: { id: orderId, tenantId: auth.tenantId },
              select: { orderNumber: true, status: true },
            }),
          )
          .catch(() => null);
        results.push({
          orderId,
          orderNumber: current?.orderNumber ?? null,
          ok: false,
          status: (current?.status as OrderStatus | undefined) ?? null,
          error: {
            code: known ? error.code : 'internal_error',
            message: known ? (error.detail ?? error.code) : 'This order could not be updated',
          },
        });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'order.bulk_status',
        metadata: { status: body.status, requested: ids.length, succeeded },
        ip,
      }),
    );
    return { results, succeeded, failed: results.length - succeeded };
  }

  // ---- editing -------------------------------------------------------------------------------------------------------

  update(
    auth: AuthContext,
    id: string,
    body: UpdateOrderBody,
    ip: string | null,
  ): Promise<OrderDetail> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const tenantId = auth.tenantId;
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      if (!locked[0]) throw ApiError.notFound('Order not found');
      const order = await tx.order.findFirstOrThrow({
        where: { id, tenantId },
        include: { items: { orderBy: { position: 'asc' } } },
      });

      if (body.ifVersion !== undefined && body.ifVersion !== order.version)
        throw new ApiError(
          'version_conflict',
          'This order was changed by someone else. Reload it and try again.',
        );

      const scope = editScope(order.status as OrderStatus);
      const touchesMoney =
        body.items !== undefined ||
        body.discountMinor !== undefined ||
        body.deliveryChargeMinor !== undefined ||
        body.advancePaidMinor !== undefined;
      const touchesContact = body.address !== undefined || body.source !== undefined;
      if (scope === 'none')
        throw ApiError.conflict(`A ${order.status} order can no longer be edited`);
      if (touchesMoney && scope !== 'full')
        throw ApiError.conflict(
          'Items and amounts can only be changed while the order is pending confirmation. Cancel it and make a new one, or change them before confirming.',
        );
      if (touchesContact && scope === 'notes')
        throw ApiError.conflict('Once shipped, only the notes can be changed');
      const data: Prisma.OrderUncheckedUpdateInput = {};
      const changed: string[] = [];
      if (body.address) {
        const next = {
          shipName: body.address.recipientName,
          shipPhone: body.address.phone,
          shipLine1: body.address.line1,
          shipArea: body.address.area,
          shipDistrict: body.address.district,
          shipDivision: body.address.division,
          shipPostalCode: body.address.postalCode ?? null,
        };
        // The courier keeps the address and phone it was booked with, so a real change would never reach the parcel.
        // (The edit form sends the address with every save, so only a difference counts.)
        if (
          Object.entries(next).some(([key, value]) => order[key as keyof typeof next] !== value) &&
          (await liveShipmentOf(tx, tenantId, id))
        )
          throw new ApiError(
            'shipment_conflict',
            'This order has a courier shipment, and the courier keeps the address it was booked with. Cancel the shipment first, then change the address and book again.',
          );
        Object.assign(data, next);
        changed.push('address');
      }
      if (body.source !== undefined) {
        data.source = body.source;
        changed.push('source');
      }
      if (body.sourceReference !== undefined) {
        data.sourceReference = body.sourceReference;
        changed.push('sourceReference');
      }
      if (body.notes !== undefined) {
        data.notes = body.notes;
        changed.push('notes');
      }

      let moneyChange: { before: object; after: object } | undefined;
      if (touchesMoney) {
        const before = moneySnapshot(order, order.items);
        // Recompute everything from the lines and the three adjustments; the client never supplies a total.
        const lines = body.items
          ? await this.resolveItems(tx, tenantId, body.items, order.items)
          : order.items.map((i) => ({
              variantId: i.variantId,
              sku: i.sku,
              productName: i.productName,
              variantName: i.variantName,
              costMinor: i.costMinor,
              quantity: i.quantity,
              unitPriceMinor: i.unitPriceMinor,
              discountMinor: i.discountMinor,
            }));
        const totals = this.totalsOrThrow({
          lines,
          discountMinor: body.discountMinor ?? order.discountMinor,
          deliveryChargeMinor: body.deliveryChargeMinor ?? order.deliveryChargeMinor,
          advancePaidMinor: body.advancePaidMinor ?? order.advancePaidMinor,
        });
        if (body.items) {
          await tx.orderItem.deleteMany({ where: { tenantId, orderId: id } });
          await tx.orderItem.createMany({
            data: lines.map((l, position) => ({
              tenantId,
              orderId: id,
              position,
              variantId: l.variantId,
              sku: l.sku,
              productName: l.productName,
              variantName: l.variantName,
              quantity: l.quantity,
              unitPriceMinor: l.unitPriceMinor,
              discountMinor: l.discountMinor,
              lineTotalMinor: totals.lineTotalsMinor[position]!,
              costMinor: l.costMinor,
            })),
          });
          changed.push('items');
        }
        Object.assign(data, {
          subtotalMinor: totals.subtotalMinor,
          discountMinor: totals.discountMinor,
          deliveryChargeMinor: totals.deliveryChargeMinor,
          totalMinor: totals.totalMinor,
          advancePaidMinor: totals.advancePaidMinor,
          codAmountMinor: totals.codAmountMinor,
        });
        moneyChange = { before, after: moneySnapshot(totals, lines) };
        if (body.discountMinor !== undefined) changed.push('discount');
        if (body.deliveryChargeMinor !== undefined) changed.push('deliveryCharge');
        if (body.advancePaidMinor !== undefined) changed.push('advancePaid');
      }

      await tx.order.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      await this.audit.record(tx, {
        tenantId,
        actorUserId: auth.userId,
        action: 'order.updated',
        targetType: 'order',
        targetId: id,
        // Field names, and for money the before and after: addresses and phone numbers stay out of the audit log.
        metadata: { orderNumber: order.orderNumber, changed, ...moneyChange },
        ip,
      });
      return this.loadDetail(tx, tenantId, id);
    });
  }

  // ---- possible duplicates -------------------------------------------------------------------------------------------

  /**
   * Recent orders that look like a repeat: same customer phone and either placed in the last ten minutes (a double
   * submit that slipped past the idempotency key) or sharing an item within three days. A hint for a person to look at.
   * It never blocks an order and says nothing about the customer.
   */
  async findDuplicates(
    tx: Tx,
    tenantId: string,
    input: DuplicateCheckBody,
  ): Promise<PotentialDuplicate[]> {
    const phone = normalizeBdPhone(input.phone);
    if (!phone) return [];
    const now = Date.now();
    const candidates = await tx.order.findMany({
      where: {
        tenantId,
        status: { not: 'cancelled' },
        createdAt: { gte: new Date(now - DUPLICATE_WINDOW_MS) },
        ...(input.excludeOrderId ? { id: { not: input.excludeOrderId } } : {}),
        OR: [{ shipPhone: phone }, { customer: { phone } }],
      },
      include: { items: { select: { variantId: true, sku: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const wanted = new Set(input.variantIds);
    const found: PotentialDuplicate[] = [];
    for (const o of candidates) {
      const reasons: string[] = [];
      const minutes = Math.floor((now - o.createdAt.getTime()) / 60_000);
      if (now - o.createdAt.getTime() < JUST_PLACED_MS)
        reasons.push(
          `Placed ${minutes < 1 ? 'less than a minute' : `${minutes} minute${minutes === 1 ? '' : 's'}`} ago for the same phone number`,
        );
      const shared = o.items.filter((i) => wanted.has(i.variantId)).map((i) => i.sku);
      if (shared.length)
        reasons.push(`Same ${shared.length === 1 ? 'item' : 'items'}: ${shared.join(', ')}`);
      if (reasons.length)
        found.push({
          orderId: o.id,
          orderNumber: o.orderNumber,
          status: o.status as OrderStatus,
          createdAt: o.createdAt.toISOString(),
          totalMinor: o.totalMinor,
          reasons,
        });
    }
    return found;
  }

  checkDuplicates(auth: AuthContext, body: DuplicateCheckBody): Promise<PotentialDuplicate[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      this.findDuplicates(tx, auth.tenantId, body),
    );
  }

  duplicatesOf(auth: AuthContext, id: string): Promise<PotentialDuplicate[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const order = await tx.order.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { items: { select: { variantId: true } } },
      });
      if (!order) throw ApiError.notFound('Order not found');
      return this.findDuplicates(tx, auth.tenantId, {
        phone: order.shipPhone,
        variantIds: order.items.map((i) => i.variantId),
        excludeOrderId: id,
      });
    });
  }
}
