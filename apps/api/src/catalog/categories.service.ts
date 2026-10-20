import { Injectable } from '@nestjs/common';
import type { Category, CategoryBody, CreateCategoryBody } from '@orderloop/contracts';
import { Database, isUniqueViolation } from '@orderloop/db';
import { nameKey } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { idempotent } from '../common/idempotency.js';
import { toCategory } from './catalog.mapper.js';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext): Promise<Category[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) =>
      (
        await tx.category.findMany({
          where: { tenantId: auth.tenantId },
          orderBy: { nameKey: 'asc' },
        })
      ).map(toCategory),
    );
  }

  async create(auth: AuthContext, body: CreateCategoryBody): Promise<Category> {
    try {
      return await idempotent(
        this.db,
        { tenantId: auth.tenantId, userId: auth.userId },
        { scope: 'POST /v1/categories', key: body.idempotencyKey, body },
        async (tx) => {
          const c = await tx.category.create({
            data: { tenantId: auth.tenantId, name: body.name, nameKey: nameKey(body.name) },
          });
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'category.created',
            targetType: 'category',
            targetId: c.id,
          });
          return toCategory(c);
        },
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw ApiError.conflict('A category with that name already exists');
      throw error;
    }
  }

  async rename(auth: AuthContext, id: string, body: CategoryBody): Promise<Category> {
    try {
      return await this.db.withContext(
        { tenantId: auth.tenantId, userId: auth.userId },
        async (tx) => {
          const found = await tx.category.findFirst({ where: { id, tenantId: auth.tenantId } });
          if (!found) throw ApiError.notFound('Category not found');
          const c = await tx.category.update({
            where: { id },
            data: { name: body.name, nameKey: nameKey(body.name) },
          });
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'category.renamed',
            targetType: 'category',
            targetId: id,
          });
          return toCategory(c);
        },
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw ApiError.conflict('A category with that name already exists');
      throw error;
    }
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const found = await tx.category.findFirst({ where: { id, tenantId: auth.tenantId } });
      if (!found) throw ApiError.notFound('Category not found');
      await tx.category.delete({ where: { id } }); // products keep existing: the foreign key sets their category to null
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'category.deleted',
        targetType: 'category',
        targetId: id,
      });
    });
  }
}
