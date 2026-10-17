import { Injectable } from '@nestjs/common';
import type { Location, LocationBody, LocationUpdate } from '@orderloop/contracts';
import { Database, isUniqueViolation } from '@orderloop/db';
import { nameKey } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { toLocation } from './catalog.mapper.js';

@Injectable()
export class LocationsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext): Promise<Location[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      return (
        await tx.stockLocation.findMany({
          where: { tenantId: auth.tenantId },
          orderBy: [{ isDefault: 'desc' }, { nameKey: 'asc' }],
        })
      ).map(toLocation);
    });
  }

  async create(auth: AuthContext, body: LocationBody): Promise<Location> {
    try {
      return await this.db.withContext(
        { tenantId: auth.tenantId, userId: auth.userId },
        async (tx) => {
          if (body.isDefault)
            await tx.stockLocation.updateMany({
              where: { tenantId: auth.tenantId, isDefault: true },
              data: { isDefault: false },
            });
          const l = await tx.stockLocation.create({
            data: {
              tenantId: auth.tenantId,
              name: body.name,
              nameKey: nameKey(body.name),
              isDefault: body.isDefault ?? false,
            },
          });
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'location.created',
            targetType: 'location',
            targetId: l.id,
          });
          return toLocation(l);
        },
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw ApiError.conflict('A location with that name already exists');
      throw error;
    }
  }

  async update(auth: AuthContext, id: string, body: LocationUpdate): Promise<Location> {
    try {
      return await this.db.withContext(
        { tenantId: auth.tenantId, userId: auth.userId },
        async (tx) => {
          const found = await tx.stockLocation.findFirst({
            where: { id, tenantId: auth.tenantId },
          });
          if (!found) throw ApiError.notFound('Location not found');
          if (body.archived === true && found.isDefault)
            throw ApiError.conflict('Make another location the default before archiving this one');
          if (body.archived === true) {
            // Lock exclusively first: stock changes hold the location FOR SHARE, so none can commit after we count.
            await tx.$queryRaw`SELECT id FROM stock_locations WHERE tenant_id = ${auth.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
            // Archiving a place that still holds or has promised stock would strand it.
            const stranded = await tx.stockLevel.count({
              where: {
                tenantId: auth.tenantId,
                locationId: id,
                OR: [{ onHand: { gt: 0 } }, { reserved: { gt: 0 } }],
              },
            });
            if (stranded > 0)
              throw ApiError.conflict(
                'This location still holds stock; move or adjust it to zero first',
              );
          }
          if (body.isDefault)
            await tx.stockLocation.updateMany({
              where: { tenantId: auth.tenantId, isDefault: true },
              data: { isDefault: false },
            });
          const l = await tx.stockLocation.update({
            where: { id },
            data: {
              ...(body.name !== undefined ? { name: body.name, nameKey: nameKey(body.name) } : {}),
              ...(body.isDefault ? { isDefault: true, archivedAt: null } : {}),
              ...(body.archived !== undefined
                ? { archivedAt: body.archived ? new Date() : null }
                : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'location.updated',
            targetType: 'location',
            targetId: id,
          });
          return toLocation(l);
        },
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw ApiError.conflict('A location with that name already exists');
      throw error;
    }
  }
}
