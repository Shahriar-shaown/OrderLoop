import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RouteSpec } from '@orderloop/contracts';
import { Database } from '@orderloop/db';
import { can } from '@orderloop/domain';
import { ApiError } from '../common/api-error.js';
import { ROUTE_SPEC, type AppRequest } from '../common/endpoint.js';
import { TokenService } from './token.service.js';

/**
 * Authenticates and authorises every non-public route.
 *
 * The access token only identifies a user, tenant and session. The session and the membership (and
 * therefore the role) are re-read from the database on every request, so logout, role changes and
 * removal take effect immediately instead of at token expiry. A business that is scheduled for deletion answers 403
 * `tenant_deleted` to everything except the few routes that declare `allowWhenTenantDeleted`.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const spec = this.reflector.get<RouteSpec | undefined>(ROUTE_SPEC, context.getHandler());
    if (!spec)
      throw new Error(
        `Handler ${context.getHandler().name} is not bound to a route in the registry`,
      );
    if (spec.auth === 'public') return true;

    const req = context.switchToHttp().getRequest<AppRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw ApiError.unauthorized();
    const claims = await this.tokens.verifyAccessToken(header.slice(7));

    const found = await this.db.withContext(
      { tenantId: claims.tenantId, userId: claims.userId },
      async (tx) => {
        const session = await tx.session.findUnique({ where: { id: claims.sessionId } });
        if (
          !session ||
          session.userId !== claims.userId ||
          session.activeTenantId !== claims.tenantId ||
          session.revokedAt ||
          session.expiresAt <= new Date()
        ) {
          return null;
        }
        const user = await tx.user.findUnique({
          where: { id: claims.userId },
          select: { disabledAt: true },
        });
        if (!user || user.disabledAt) return null; // a disabled account loses access at once, not at token expiry
        const membership = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: claims.tenantId, userId: claims.userId } },
        });
        if (!membership) return null;
        const tenant = await tx.tenant.findUnique({
          where: { id: claims.tenantId },
          select: { purgeAfter: true },
        });
        return { role: membership.role, deletionScheduled: tenant?.purgeAfter != null };
      },
    );
    if (!found) throw ApiError.unauthorized('Session is no longer valid');

    req.auth = {
      userId: claims.userId,
      tenantId: claims.tenantId,
      sessionId: claims.sessionId,
      role: found.role,
    };
    // Before the permission check on purpose: nobody, whatever their role, gets past a business that is going away.
    if (found.deletionScheduled && !spec.allowWhenTenantDeleted)
      throw new ApiError(
        'tenant_deleted',
        'This business is scheduled for deletion, so it cannot be used. Its owner can still cancel the deletion.',
      );
    if (spec.permission && !can(found.role, spec.permission)) throw ApiError.forbidden();
    return true;
  }
}
