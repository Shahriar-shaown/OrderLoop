import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
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
  UpdateOrderBody,
} from '@orderloop/contracts';
import { Database, isUniqueViolation, Prisma, type Tx } from '@orderloop/db';
import {
  calculateOrderTotals,
  canTransition,
  editScope,
  normalizeBdPhone,
  OrderTotalsError,
  REASON_REQUIRED,
  stockEffect,
  type OrderTotals,
} from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { StockRunner } from '../inventory/inventory.service.js';
import { CustomersService } from './customers.service.js';
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
  releaseOrder,
  reserveOrder,
  restockOrder,
  shipOrder,
  type LineRef,
} from './order-stock.js';

const validation = (path: string, message: string) =>
  new ApiError(400, 'validation_failed', 'Request validation failed', [{ path, message }]);

/** Sorted-keys JSON, so the same request always hashes the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const orderInclude = {
  items: { orderBy: { position: 'asc' as const } },
  customer: { select: { id: true, name: true, phone: true } },
} satisfies Prisma.OrderInclude;

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
                          WHERE si.tenant_id = o.tenant_id AND si.order_id = o.id AND si.match_status = 'matched' AND si.kind = 'cod'), 0) AS collected,
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

  /** Check each requested variant exists in this business and can be sold; return the snapshot to store on the line. */
  private async resolveItems(tx: Tx, tenantId: string, items: CreateOrderBody['items']) {
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
      if (v.archivedAt || v.product.status === 'ARCHIVED')
        throw validation(`body.items.${i}.variantId`, `${v.sku} is archived and cannot be ordered`);
      return {
        variantId: v.id,
        sku: v.sku,
        productName: v.product.name,
        variantName: v.name,
        costMinor: v.costMinor,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor ?? v.priceMinor,
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

  async create(auth: AuthContext, body: CreateOrderBody, ip: string | null): Promise<OrderDetail> {
    const { idempotencyKey, ...rest } = body;
    const requestHash = createHash('sha256').update(stable(rest)).digest('hex');
    const attempt = () =>
      this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
        const existing = await tx.order.findUnique({
          where: { tenantId_idempotencyKey: { tenantId: auth.tenantId, idempotencyKey } },
          select: { id: true, requestHash: true },
        });
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new ApiError(
              409,
              'idempotency_conflict',
              'This idempotency key was already used for a different order',
            );
          return this.loadDetail(tx, auth.tenantId, existing.id);
        }
        return this.createInTx(tx, auth, body, requestHash, ip);
      });
    try {
      return await attempt();
    } catch (error) {
      // Two requests with one key raced: the loser's insert hit the unique index and rolled back. Now the key exists.
      if (isUniqueViolation(error, 'idempotency_key')) return attempt();
      throw error;
    }
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
      await this.customers.saveAddressIfNew(tx, tenantId, customerId, ship!);
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
    /** `userId` is null when the courier, not a person, causes the move (a delivery update): the history then shows no actor. */
    auth: { tenantId: string; userId: string | null },
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

    if (body.ifVersion !== undefined && body.ifVersion !== order.version)
      throw new ApiError(
        409,
        'version_conflict',
        'This order was changed by someone else. Reload it and try again.',
      );
    if (!canTransition(from, to))
      throw new ApiError(
        409,
        'invalid_transition',
        `An order that is ${from.replace(/_/g, ' ')} cannot become ${to.replace(/_/g, ' ')}`,
      );
    if (to === 'cancelled') {
      // An order cannot be cancelled while a parcel for it exists (or may exist) at a courier: that parcel would still be delivered and collected on.
      const live = await tx.shipment.findFirst({
        where: { tenantId, orderId: id, status: { notIn: ['booking_failed', 'cancelled'] } },
        select: { provider: true, status: true },
      });
      if (live)
        throw new ApiError(
          409,
          'shipment_conflict',
          live.status === 'booking' || live.status === 'booking_uncertain'
            ? 'A courier booking for this order is unconfirmed. Settle it on the order page before cancelling.'
            : 'This order has a live courier shipment. Cancel the shipment first, then cancel the order.',
        );
    }
    const reason = body.reason?.trim() || defaultReason;
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
        const known = new Set(lines.map((l) => l.id));
        const conditions = new Map<string, 'RESALEABLE' | 'DAMAGED'>();
        for (const [i, r] of (body.returnedItems ?? []).entries()) {
          if (!known.has(r.itemId))
            throw validation(`body.returnedItems.${i}.itemId`, 'That line is not on this order');
          conditions.set(r.itemId, r.condition);
        }
        await restockOrder(tx, actor, id, lines, conditions, reason ?? 'Order returned');
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
      metadata: { orderNumber: order.orderNumber, from, to },
      ip,
    });
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
          409,
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
        Object.assign(data, {
          shipName: body.address.recipientName,
          shipPhone: body.address.phone,
          shipLine1: body.address.line1,
          shipArea: body.address.area,
          shipDistrict: body.address.district,
          shipDivision: body.address.division,
          shipPostalCode: body.address.postalCode ?? null,
        });
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

      if (touchesMoney) {
        // Recompute everything from the lines and the three adjustments; the client never supplies a total.
        const lines = body.items
          ? await this.resolveItems(tx, tenantId, body.items)
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
        // Field names only: addresses and phone numbers stay out of the audit log.
        metadata: { orderNumber: order.orderNumber, changed },
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
