import { Inject, Injectable } from '@nestjs/common';
import type { RequestTenantDeletionBody, Role, TenantDeletionStatus } from '@orderloop/contracts';
import { Database, type Tx } from '@orderloop/db';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { MailService } from '../mail/mail.service.js';
import { templates } from '../mail/templates.js';
import { markDisconnected } from '../meta/connections.service.js';
import { ReauthService } from './reauth.service.js';

const DAY_MS = 86_400_000;

export interface Scheduled {
  purgeAfter: Date;
  /** Everyone who belonged to the business when it was scheduled (to tell them after the commit). */
  memberEmails: string[];
}

/**
 * Deleting a whole business, in two steps: the owner asks (this service: the business stops working at once, credentials
 * go, everyone is told), and after the grace period the worker deletes every row (the SQL function `purge_tenant`).
 */
@Injectable()
export class TenantDeletionService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly reauth: ReauthService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get webBase(): string {
    return this.config.WEB_ORIGINS[0]!;
  }

  private status(
    tenant: { name: string; deletionRequestedAt: Date | null; purgeAfter: Date | null },
    role: Role | null,
  ): TenantDeletionStatus {
    const scheduled = tenant.purgeAfter !== null;
    return {
      businessName: tenant.name,
      scheduled,
      requestedAt: tenant.deletionRequestedAt?.toISOString() ?? null,
      purgeAfter: tenant.purgeAfter?.toISOString() ?? null,
      graceDays: this.config.TENANT_DELETION_GRACE_DAYS,
      canCancel: scheduled && role === 'OWNER' && tenant.purgeAfter!.getTime() > Date.now(),
    };
  }

  async current(auth: AuthContext): Promise<TenantDeletionStatus> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId } });
      if (!tenant) throw ApiError.notFound('Business not found');
      return this.status(tenant, auth.role);
    });
  }

  /**
   * What happens the moment a business is scheduled, inside the caller's transaction (already scoped to the business):
   * automation rules off, courier credentials and Meta tokens deleted (connections disconnected), pending invitations revoked,
   * every member's sessions for this business ended (except `keepSessionId`, the owner's own, so they can reach "Cancel").
   * Nothing is deleted from the business's data here: that is the purge, after the grace period.
   */
  async scheduleInTx(
    tx: Tx,
    input: { tenantId: string; requestedById: string; keepSessionId?: string; source: string },
    ip: string | null,
  ): Promise<Scheduled> {
    const now = new Date();
    const purgeAfter = new Date(now.getTime() + this.config.TENANT_DELETION_GRACE_DAYS * DAY_MS);
    await tx.tenant.update({
      where: { id: input.tenantId },
      data: {
        deletionRequestedAt: now,
        purgeAfter,
        deletionRequestedById: input.requestedById,
      },
    });
    await tx.automationRule.updateMany({
      where: { tenantId: input.tenantId, enabled: true },
      data: { enabled: false, enabledAt: null },
    });
    await tx.courierConnection.updateMany({
      where: { tenantId: input.tenantId },
      data: { credentialsEnc: null, webhookSecretEnc: null, enabled: false },
    });
    const live = await tx.socialConnection.findMany({
      where: { tenantId: input.tenantId, status: { not: 'disconnected' } },
      select: { id: true },
    });
    for (const c of live) await markDisconnected(tx, input.tenantId, c.id);
    // A hand-over in progress holds a sealed user token.
    await tx.socialOauthSession.deleteMany({ where: { tenantId: input.tenantId } });
    await tx.invitation.updateMany({
      where: { tenantId: input.tenantId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    // Global table: every session scoped to this business, whoever's it is.
    await tx.session.updateMany({
      where: {
        activeTenantId: input.tenantId,
        revokedAt: null,
        ...(input.keepSessionId ? { id: { not: input.keepSessionId } } : {}),
      },
      data: { revokedAt: now, revokedReason: 'tenant_deletion' },
    });
    const members = await tx.membership.findMany({
      where: { tenantId: input.tenantId },
      select: { user: { select: { email: true, deletedAt: true } } },
    });
    await this.audit.record(tx, {
      tenantId: input.tenantId,
      actorUserId: input.requestedById,
      action: 'tenant.deletion_requested',
      targetType: 'tenant',
      targetId: input.tenantId,
      metadata: {
        purgeAfter: purgeAfter.toISOString(),
        graceDays: this.config.TENANT_DELETION_GRACE_DAYS,
        source: input.source,
        courierConnections: 'credentials_deleted',
        socialConnectionsDisconnected: live.length,
      },
      ip,
    });
    return {
      purgeAfter,
      memberEmails: members.filter((m) => !m.user.deletedAt).map((m) => m.user.email),
    };
  }

  /** The owner asks. Their name and password are required; asking again returns the same date and sends nothing. */
  async request(
    auth: AuthContext,
    body: RequestTenantDeletionBody,
    ip: string | null,
  ): Promise<TenantDeletionStatus> {
    await this.reauth.assertPassword(auth.userId, body.password, ip);
    const result = await this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        // One request at a time per business, so two owners clicking together schedule it once.
        await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${auth.tenantId}::uuid FOR UPDATE`;
        const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId } });
        if (!tenant) throw ApiError.notFound('Business not found');
        if (tenant.purgeAfter) return { status: this.status(tenant, auth.role), scheduled: null };
        if (body.confirmName.trim() !== tenant.name.trim())
          throw new ApiError('validation_failed', 'Request validation failed', [
            { path: 'body.confirmName', message: 'Type the business name exactly as it is shown' },
          ]);
        const scheduled = await this.scheduleInTx(
          tx,
          {
            tenantId: auth.tenantId,
            requestedById: auth.userId,
            keepSessionId: auth.sessionId,
            source: 'owner',
          },
          ip,
        );
        const after = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
        return { status: this.status(after, auth.role), scheduled };
      },
    );
    // After the commit, so nobody is told about a deletion that rolled back.
    if (result.scheduled)
      for (const email of result.scheduled.memberEmails)
        await this.mail.send(
          templates.tenantDeletionScheduled(email, this.webBase, result.scheduled.purgeAfter),
        );
    return result.status;
  }

  /**
   * The owner changes their mind, within the grace period. The business works again; what was deleted at the request (courier
   * credentials, Meta tokens) is not restored, and automation rules stay off until someone switches them on.
   */
  async cancel(auth: AuthContext, ip: string | null): Promise<TenantDeletionStatus> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${auth.tenantId}::uuid FOR UPDATE`;
      const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId } });
      if (!tenant) throw ApiError.notFound('Business not found');
      if (!tenant.purgeAfter)
        throw ApiError.conflict('This business is not scheduled for deletion');
      if (tenant.purgeAfter.getTime() <= Date.now())
        throw ApiError.conflict(
          'The grace period has ended, so the deletion can no longer be cancelled',
        );
      const after = await tx.tenant.update({
        where: { id: auth.tenantId },
        data: { deletionRequestedAt: null, purgeAfter: null, deletionRequestedById: null },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'tenant.deletion_cancelled',
        targetType: 'tenant',
        targetId: auth.tenantId,
        ip,
      });
      return this.status(after, auth.role);
    });
  }
}
