import { Injectable } from '@nestjs/common';
import type { Supplier, SupplierBody, SupplierUpdate } from '@orderloop/contracts';
import { Database, isUniqueViolation } from '@orderloop/db';
import { nameKey } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { idempotent } from '../common/idempotency.js';
import { toSupplier } from './catalog.mapper.js';

const DUPLICATE = () => ApiError.conflict('A supplier with that name already exists');

@Injectable()
export class SuppliersService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext): Promise<Supplier[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) =>
      (
        await tx.supplier.findMany({
          where: { tenantId: auth.tenantId },
          orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { nameKey: 'asc' }],
        })
      ).map(toSupplier),
    );
  }

  async create(auth: AuthContext, body: SupplierBody): Promise<Supplier> {
    try {
      return await idempotent(
        this.db,
        { tenantId: auth.tenantId, userId: auth.userId },
        { scope: 'POST /v1/suppliers', key: body.idempotencyKey, body },
        async (tx) => {
          const s = await tx.supplier.create({
            data: {
              tenantId: auth.tenantId,
              name: body.name,
              nameKey: nameKey(body.name),
              contactName: body.contactName ?? null,
              phone: body.phone ?? null,
              email: body.email ?? null,
              address: body.address ?? null,
              notes: body.notes ?? null,
            },
          });
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'supplier.created',
            targetType: 'supplier',
            targetId: s.id,
          });
          return toSupplier(s);
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw DUPLICATE();
      throw error;
    }
  }

  async update(auth: AuthContext, id: string, body: SupplierUpdate): Promise<Supplier> {
    try {
      return await this.db.withContext(
        { tenantId: auth.tenantId, userId: auth.userId },
        async (tx) => {
          // Another business's id is invisible under row-level security: not found, exactly like a missing one.
          const found = await tx.supplier.findFirst({ where: { id, tenantId: auth.tenantId } });
          if (!found) throw ApiError.notFound('Supplier not found');
          const s = await tx.supplier.update({
            where: { id },
            data: {
              ...(body.name !== undefined ? { name: body.name, nameKey: nameKey(body.name) } : {}),
              ...(body.contactName !== undefined ? { contactName: body.contactName } : {}),
              ...(body.phone !== undefined ? { phone: body.phone } : {}),
              ...(body.email !== undefined ? { email: body.email } : {}),
              ...(body.address !== undefined ? { address: body.address } : {}),
              ...(body.notes !== undefined ? { notes: body.notes } : {}),
              ...(body.archived !== undefined
                ? { archivedAt: body.archived ? (found.archivedAt ?? new Date()) : null }
                : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action:
              body.archived === true && !found.archivedAt
                ? 'supplier.archived'
                : 'supplier.updated',
            targetType: 'supplier',
            targetId: id,
          });
          return toSupplier(s);
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw DUPLICATE();
      throw error;
    }
  }
}
