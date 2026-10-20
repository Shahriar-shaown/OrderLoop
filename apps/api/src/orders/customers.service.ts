import { Injectable } from '@nestjs/common';
import type {
  CreateAddressBody,
  AddressFields,
  AddressRecord,
  AddressUpdate,
  Customer,
  CustomerBody,
  CustomerDetail,
  CustomerPage,
  CustomerQuery,
  CustomerStats,
  CustomerUpdate,
} from '@orderloop/contracts';
import { Database, isUniqueViolation, type Tx } from '@orderloop/db';
import { nameKey } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import type { AuthContext } from '../common/endpoint.js';
import { idempotent } from '../common/idempotency.js';
import { uuidv7 } from '../common/uuid.js';

const validation = (path: string, message: string) =>
  new ApiError('validation_failed', 'Request validation failed', [{ path, message }]);

const PHONE_TAKEN = () =>
  ApiError.conflict(
    'A customer with this phone number already exists. Open that customer instead.',
  );

type CustomerRow = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  notes: string | null;
  createdAt: Date;
};

const EMPTY_STATS: CustomerStats = {
  ordersCount: 0,
  deliveredCount: 0,
  cancelledCount: 0,
  returnedCount: 0,
  deliveredValueMinor: 0,
  lastOrderAt: null,
};

const toCustomer = (c: CustomerRow, stats: CustomerStats): Customer => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  email: c.email,
  notes: c.notes,
  createdAt: c.createdAt.toISOString(),
  stats,
});

type AddressRow = {
  id: string;
  label: string | null;
  recipientName: string;
  phone: string;
  line1: string;
  area: string;
  district: string;
  division: string;
  postalCode: string | null;
  isDefault: boolean;
};
const toAddress = (a: AddressRow): AddressRecord => ({
  id: a.id,
  label: a.label,
  recipientName: a.recipientName,
  phone: a.phone,
  line1: a.line1,
  area: a.area,
  district: a.district,
  division: a.division,
  postalCode: a.postalCode,
  isDefault: a.isDefault,
});

@Injectable()
export class CustomersService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * Plain counts per customer. Deliberately no score, rating or flag: the app never classifies a customer. People
   * decide what a number of returns means.
   */
  private async stats(
    tx: Tx,
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, CustomerStats>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.$queryRaw<
      {
        customer_id: string;
        orders: number;
        delivered: number;
        cancelled: number;
        returned: number;
        delivered_value: bigint;
        last_order_at: Date | null;
      }[]
    >`
      SELECT customer_id, count(*)::int AS orders,
             (count(*) FILTER (WHERE status = 'delivered'))::int AS delivered,
             (count(*) FILTER (WHERE status = 'cancelled'))::int AS cancelled,
             (count(*) FILTER (WHERE status = 'returned'))::int AS returned,
             COALESCE(sum(total_minor) FILTER (WHERE status = 'delivered'), 0) AS delivered_value,
             max(created_at) AS last_order_at
      FROM orders
      WHERE tenant_id = ${tenantId}::uuid AND customer_id = ANY(${ids}::uuid[])
      GROUP BY customer_id`;
    return new Map(
      rows.map((r) => [
        r.customer_id,
        {
          ordersCount: r.orders,
          deliveredCount: r.delivered,
          cancelledCount: r.cancelled,
          returnedCount: r.returned,
          deliveredValueMinor: Number(r.delivered_value),
          lastOrderAt: r.last_order_at?.toISOString() ?? null,
        },
      ]),
    );
  }

  // ---- used by order creation ----------------------------------------------------------------------------------------

  async requireId(tx: Tx, tenantId: string, customerId: string, path: string): Promise<string> {
    const found = await tx.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { id: true },
    });
    if (!found) throw validation(path, 'Customer not found');
    return found.id;
  }

  /**
   * The customer with this phone number, created if there is none. One statement, so two orders for a new number at the
   * same moment still end up with one customer. An existing customer's details are left as they are.
   */
  async findOrCreateByPhone(
    tx: Tx,
    tenantId: string,
    input: { name: string; phone: string; email?: string | null | undefined },
  ): Promise<string> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO customers (id, tenant_id, name, name_key, phone, email, updated_at)
      VALUES (${uuidv7()}::uuid, ${tenantId}::uuid, ${input.name}, ${nameKey(input.name)}, ${input.phone}, ${input.email ?? null}, now())
      ON CONFLICT (tenant_id, phone) DO UPDATE SET phone = EXCLUDED.phone
      RETURNING id`;
    return rows[0]!.id;
  }

  /** Remember a typed-in address on the customer, unless the same one is already there. */
  async saveAddressIfNew(
    tx: Tx,
    tenantId: string,
    customerId: string,
    a: AddressFields,
  ): Promise<void> {
    const existing = await tx.customerAddress.findMany({ where: { tenantId, customerId } });
    const norm = (s: string) => s.trim().toLowerCase();
    const same = existing.some(
      (e) =>
        norm(e.line1) === norm(a.line1) &&
        norm(e.area) === norm(a.area) &&
        norm(e.district) === norm(a.district) &&
        e.phone === a.phone,
    );
    if (same || existing.length >= 20) return;
    await tx.customerAddress.create({
      data: {
        tenantId,
        customerId,
        recipientName: a.recipientName,
        phone: a.phone,
        line1: a.line1,
        area: a.area,
        district: a.district,
        division: a.division,
        postalCode: a.postalCode ?? null,
        isDefault: existing.length === 0,
      },
    });
  }

  // ---- customers -----------------------------------------------------------------------------------------------------

  async list(auth: AuthContext, query: CustomerQuery): Promise<CustomerPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const q = query.q?.trim();
      const digits = q ? q.replace(/\D/g, '').replace(/^(?:880|0)/, '') : '';
      const phoneSearch = q && /^[\d\s+\-().]+$/.test(q) && digits.length >= 3 ? digits : null;
      const rows = await tx.customer.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(q
            ? {
                OR: [
                  { nameKey: { contains: nameKey(q) } },
                  ...(phoneSearch ? [{ phone: { contains: phoneSearch } }] : []),
                ],
              }
            : {}),
          ...(cursor
            ? {
                AND: [
                  {
                    OR: [
                      { createdAt: { lt: cursor.createdAt } },
                      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const stats = await this.stats(
        tx,
        auth.tenantId,
        page.map((c) => c.id),
      );
      const last = page.at(-1);
      return {
        items: page.map((c) => toCustomer(c, stats.get(c.id) ?? EMPTY_STATS)),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    });
  }

  private async detail(tx: Tx, tenantId: string, id: string): Promise<CustomerDetail> {
    const c = await tx.customer.findFirst({
      where: { id, tenantId },
      include: { addresses: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] } },
    });
    // Another business's customer id is invisible under row-level security: not found, like a missing one.
    if (!c) throw ApiError.notFound('Customer not found');
    const stats = await this.stats(tx, tenantId, [id]);
    return {
      ...toCustomer(c, stats.get(id) ?? EMPTY_STATS),
      addresses: c.addresses.map(toAddress),
    };
  }

  get(auth: AuthContext, id: string): Promise<CustomerDetail> {
    return this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      this.detail(tx, auth.tenantId, id),
    );
  }

  async create(auth: AuthContext, body: CustomerBody, ip: string | null): Promise<CustomerDetail> {
    try {
      return await idempotent(
        this.db,
        { tenantId: auth.tenantId, userId: auth.userId },
        { scope: 'POST /v1/customers', key: body.idempotencyKey, body },
        async (tx) => {
          const c = await tx.customer.create({
            data: {
              tenantId: auth.tenantId,
              name: body.name,
              nameKey: nameKey(body.name),
              phone: body.phone,
              email: body.email ?? null,
              notes: body.notes ?? null,
            },
          });
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'customer.created',
            targetType: 'customer',
            targetId: c.id,
            ip,
          });
          return this.detail(tx, auth.tenantId, c.id);
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw PHONE_TAKEN();
      throw error;
    }
  }

  async update(
    auth: AuthContext,
    id: string,
    body: CustomerUpdate,
    ip: string | null,
  ): Promise<CustomerDetail> {
    try {
      return await this.db.withContext(
        { tenantId: auth.tenantId, userId: auth.userId },
        async (tx) => {
          const found = await tx.customer.findFirst({
            where: { id, tenantId: auth.tenantId },
            select: { id: true },
          });
          if (!found) throw ApiError.notFound('Customer not found');
          await tx.customer.update({
            where: { id },
            data: {
              ...(body.name !== undefined ? { name: body.name, nameKey: nameKey(body.name) } : {}),
              ...(body.phone !== undefined ? { phone: body.phone } : {}),
              ...(body.email !== undefined ? { email: body.email } : {}),
              ...(body.notes !== undefined ? { notes: body.notes } : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'customer.updated',
            targetType: 'customer',
            targetId: id,
            metadata: { changed: Object.keys(body) },
            ip,
          });
          return this.detail(tx, auth.tenantId, id);
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw PHONE_TAKEN();
      throw error;
    }
  }

  // ---- addresses -----------------------------------------------------------------------------------------------------

  async addAddress(
    auth: AuthContext,
    customerId: string,
    body: CreateAddressBody,
    ip: string | null,
  ): Promise<AddressRecord> {
    const scope = `POST /v1/customers/${customerId}/addresses`;
    const ctx = { tenantId: auth.tenantId, userId: auth.userId };
    return idempotent(this.db, ctx, { scope, key: body.idempotencyKey, body }, async (tx) => {
      const c = await tx.customer.findFirst({
        where: { id: customerId, tenantId: auth.tenantId },
        select: { id: true },
      });
      if (!c) throw ApiError.notFound('Customer not found');
      // Serialise a customer's address changes so "only one default" cannot be broken by two requests at once.
      await tx.$queryRaw`SELECT id FROM customers WHERE tenant_id = ${auth.tenantId}::uuid AND id = ${customerId}::uuid FOR UPDATE`;
      const existing = await tx.customerAddress.count({
        where: { tenantId: auth.tenantId, customerId },
      });
      if (existing >= 20) throw ApiError.conflict('A customer can have at most 20 saved addresses');
      const makeDefault = body.isDefault === true || existing === 0;
      if (makeDefault)
        await tx.customerAddress.updateMany({
          where: { tenantId: auth.tenantId, customerId, isDefault: true },
          data: { isDefault: false },
        });
      const a = await tx.customerAddress.create({
        data: {
          tenantId: auth.tenantId,
          customerId,
          label: body.label ?? null,
          recipientName: body.recipientName,
          phone: body.phone,
          line1: body.line1,
          area: body.area,
          district: body.district,
          division: body.division,
          postalCode: body.postalCode ?? null,
          isDefault: makeDefault,
        },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'customer.address_added',
        targetType: 'customer',
        targetId: customerId,
        ip,
      });
      return toAddress(a);
    });
  }

  async updateAddress(
    auth: AuthContext,
    customerId: string,
    addressId: string,
    body: AddressUpdate,
    ip: string | null,
  ): Promise<AddressRecord> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      await tx.$queryRaw`SELECT id FROM customers WHERE tenant_id = ${auth.tenantId}::uuid AND id = ${customerId}::uuid FOR UPDATE`;
      const found = await tx.customerAddress.findFirst({
        where: { id: addressId, customerId, tenantId: auth.tenantId },
      });
      if (!found) throw ApiError.notFound('Address not found');
      if (body.isDefault === true)
        await tx.customerAddress.updateMany({
          where: { tenantId: auth.tenantId, customerId, isDefault: true },
          data: { isDefault: false },
        });
      const a = await tx.customerAddress.update({
        where: { id: addressId },
        data: {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.recipientName !== undefined ? { recipientName: body.recipientName } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.line1 !== undefined ? { line1: body.line1 } : {}),
          ...(body.area !== undefined ? { area: body.area } : {}),
          ...(body.district !== undefined ? { district: body.district } : {}),
          ...(body.division !== undefined ? { division: body.division } : {}),
          ...(body.postalCode !== undefined ? { postalCode: body.postalCode } : {}),
          // An address cannot be un-defaulted directly: make another one the default instead.
          ...(body.isDefault === true ? { isDefault: true } : {}),
        },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'customer.address_updated',
        targetType: 'customer',
        targetId: customerId,
        ip,
      });
      return toAddress(a);
    });
  }

  async deleteAddress(
    auth: AuthContext,
    customerId: string,
    addressId: string,
    ip: string | null,
  ): Promise<void> {
    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      await tx.$queryRaw`SELECT id FROM customers WHERE tenant_id = ${auth.tenantId}::uuid AND id = ${customerId}::uuid FOR UPDATE`;
      const found = await tx.customerAddress.findFirst({
        where: { id: addressId, customerId, tenantId: auth.tenantId },
      });
      if (!found) throw ApiError.notFound('Address not found');
      await tx.customerAddress.delete({ where: { id: addressId } });
      if (found.isDefault) {
        const next = await tx.customerAddress.findFirst({
          where: { tenantId: auth.tenantId, customerId },
          orderBy: { createdAt: 'asc' },
        });
        if (next)
          await tx.customerAddress.update({ where: { id: next.id }, data: { isDefault: true } });
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'customer.address_removed',
        targetType: 'customer',
        targetId: customerId,
        ip,
      });
    });
  }
}
