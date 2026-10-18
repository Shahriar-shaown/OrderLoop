import { Injectable } from '@nestjs/common';
import type {
  CreateWorkspaceBody,
  Currency,
  TenantInfo,
  Timezone,
  UpdateTenantBody,
  Workspace,
} from '@orderloop/contracts';
import { Database, type Tx } from '@orderloop/db';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { uuidv7 } from '../common/uuid.js';

/** A person can own this many businesses. A guard against runaway creation, not a billing rule. */
export const MAX_OWNED_WORKSPACES = 10;

type TenantRow = Awaited<ReturnType<Tx['tenant']['findUniqueOrThrow']>>;

function toInfo(t: TenantRow): TenantInfo {
  return {
    id: t.id,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
    logoUrl: t.logoUrl,
    contactEmail: t.contactEmail,
    contactPhone: t.contactPhone,
    addressLine1: t.addressLine1,
    addressLine2: t.addressLine2,
    city: t.city,
    district: t.district,
    postalCode: t.postalCode,
    country: t.country,
    // Only ever written through the contract's allowlists.
    currency: t.currency as Currency,
    timezone: t.timezone as Timezone,
    defaultLanguage: t.defaultLanguage,
  };
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** The current business. The id comes from the verified session (AccessGuard), never from the request. */
  async current(auth: AuthContext): Promise<TenantInfo> {
    const t = await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      tx.tenant.findUnique({ where: { id: auth.tenantId } }),
    );
    if (!t) throw ApiError.notFound('Business not found');
    return toInfo(t);
  }

  /**
   * Every business the caller belongs to. No tenant context is set: row-level security exposes the caller's own
   * membership rows, and the tenants behind them, and nothing else.
   */
  list(auth: AuthContext): Promise<Workspace[]> {
    return this.db.withContext({ userId: auth.userId }, async (tx) => {
      const rows = await tx.membership.findMany({
        where: { userId: auth.userId },
        include: { tenant: true },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((m) => ({
        id: m.tenant.id,
        name: m.tenant.name,
        logoUrl: m.tenant.logoUrl,
        currency: m.tenant.currency as Currency,
        timezone: m.tenant.timezone as Timezone,
        defaultLanguage: m.tenant.defaultLanguage,
        role: m.role,
        joinedAt: m.createdAt.toISOString(),
      }));
    });
  }

  async create(
    auth: AuthContext,
    body: CreateWorkspaceBody,
    ip: string | null,
  ): Promise<Workspace> {
    // Generated here so the tenant context exists before the tenant row does.
    const tenantId = uuidv7();
    return this.db.withContext({ tenantId, userId: auth.userId }, async (tx) => {
      // Serialise this person's creations so two simultaneous requests cannot both slip under the cap.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${auth.userId}::uuid FOR UPDATE`;
      const owned = await tx.membership.count({ where: { userId: auth.userId, role: 'OWNER' } });
      if (owned >= MAX_OWNED_WORKSPACES)
        throw ApiError.conflict(`You can own at most ${MAX_OWNED_WORKSPACES} businesses`);
      const t = await tx.tenant.create({
        data: {
          id: tenantId,
          name: body.name,
          ...(body.currency ? { currency: body.currency } : {}),
          ...(body.timezone ? { timezone: body.timezone } : {}),
          ...(body.defaultLanguage ? { defaultLanguage: body.defaultLanguage } : {}),
        },
      });
      const m = await tx.membership.create({
        data: { tenantId, userId: auth.userId, role: 'OWNER' },
      });
      await this.audit.record(tx, {
        tenantId,
        actorUserId: auth.userId,
        action: 'tenant.created',
        targetType: 'tenant',
        targetId: tenantId,
        metadata: { source: 'workspace', fromTenantId: auth.tenantId },
        ip,
      });
      return {
        id: t.id,
        name: t.name,
        logoUrl: t.logoUrl,
        currency: t.currency as Currency,
        timezone: t.timezone as Timezone,
        defaultLanguage: t.defaultLanguage,
        role: m.role,
        joinedAt: m.createdAt.toISOString(),
      };
    });
  }

  /** Only the caller's current business can be changed: the target is the verified session's tenant, not a request value. */
  async update(auth: AuthContext, body: UpdateTenantBody, ip: string | null): Promise<TenantInfo> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const before = await tx.tenant.findUnique({ where: { id: auth.tenantId } });
      if (!before) throw ApiError.notFound('Business not found');
      const changed = (Object.keys(body) as (keyof UpdateTenantBody)[]).filter(
        (k) => body[k] !== before[k],
      );
      if (changed.length === 0) return toInfo(before);
      const after = await tx.tenant.update({ where: { id: auth.tenantId }, data: body });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'tenant.updated',
        targetType: 'tenant',
        targetId: auth.tenantId,
        // Field names only: contact details and addresses stay out of the log.
        metadata: { changed },
        ip,
      });
      return toInfo(after);
    });
  }
}
