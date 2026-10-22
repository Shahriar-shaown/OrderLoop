import { Injectable } from '@nestjs/common';
import type {
  DeleteAccountBody,
  DeleteAccountResult,
  ScheduledBusiness,
} from '@orderloop/contracts';
import { applyContext, Database } from '@orderloop/db';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { MailService } from '../mail/mail.service.js';
import { templates } from '../mail/templates.js';
import { ReauthService } from './reauth.service.js';
import { TenantDeletionService } from './tenant-deletion.service.js';

interface Membership {
  tenantId: string;
  role: string;
}

/**
 * A person deletes their own account. The person's row stays (orders, audit and the stock ledger refer to its id) but is
 * anonymised, can no longer sign in, and gives up its email address. Everything personal to the person goes: sessions and
 * tokens, phones registered for notifications, notification settings, SMS/WhatsApp consent, the IP addresses in the audit rows
 * their actions left, and every membership. A business they alone belong to goes through business deletion (grace period); a
 * business with other members that they alone own blocks this until ownership is handed over.
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly reauth: ReauthService,
    private readonly tenants: TenantDeletionService,
    private readonly mail: MailService,
  ) {}

  async deleteAccount(
    auth: AuthContext,
    body: DeleteAccountBody,
    ip: string | null,
  ): Promise<DeleteAccountResult> {
    const { email } = await this.reauth.assertPassword(auth.userId, body.password, ip);

    const scheduledNow: ScheduledBusiness[] = [];
    await this.db.withContext({ userId: auth.userId }, async (tx) => {
      scheduledNow.length = 0; // a retried transaction starts again
      // One deletion at a time for this person.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${auth.userId}::uuid FOR UPDATE`;
      const memberships: Membership[] = await tx.membership.findMany({
        where: { userId: auth.userId },
        select: { tenantId: true, role: true },
        orderBy: { createdAt: 'asc' },
      });

      // First look at every business, change nothing: a refusal must leave everything as it was.
      type Facts = {
        tenantId: string;
        name: string;
        members: number;
        owners: number;
        mine: string;
        scheduled: boolean;
      };
      const facts: Facts[] = [];
      for (const m of memberships) {
        await applyContext(tx, { tenantId: m.tenantId, userId: auth.userId });
        await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${m.tenantId}::uuid FOR UPDATE`;
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: m.tenantId },
          select: { name: true, purgeAfter: true },
        });
        const [members, owners] = await Promise.all([
          tx.membership.count({ where: { tenantId: m.tenantId } }),
          tx.membership.count({ where: { tenantId: m.tenantId, role: 'OWNER' } }),
        ]);
        facts.push({
          tenantId: m.tenantId,
          name: tenant.name,
          members,
          owners,
          mine: m.role,
          scheduled: tenant.purgeAfter !== null,
        });
      }
      const blocked = facts.filter(
        (f) => f.mine === 'OWNER' && f.owners === 1 && f.members > 1 && !f.scheduled,
      );
      if (blocked.length > 0)
        throw new ApiError(
          'account_delete_blocked',
          'You are the only owner of a business that has other members. Make someone else an owner or remove the other members first, then delete your account.',
          // The businesses in the way, one per entry, so a screen can list them (a path of `businesses` is not a form field).
          blocked.map((f) => ({ path: 'businesses', message: f.name })),
        );

      for (const f of facts) {
        await applyContext(tx, { tenantId: f.tenantId, userId: auth.userId });
        await this.audit.record(tx, {
          tenantId: f.tenantId,
          actorUserId: auth.userId,
          action: 'account.deleted',
          targetType: 'user',
          targetId: auth.userId,
          ip,
        });
        // Invitations they sent carry their authority, which ends here.
        await tx.invitation.updateMany({
          where: {
            tenantId: f.tenantId,
            invitedById: auth.userId,
            acceptedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
        if (f.members === 1 && !f.scheduled) {
          const s = await this.tenants.scheduleInTx(
            tx,
            { tenantId: f.tenantId, requestedById: auth.userId, source: 'account_deletion' },
            ip,
          );
          scheduledNow.push({
            id: f.tenantId,
            name: f.name,
            purgeAfter: s.purgeAfter.toISOString(),
          });
        }
        // Notifications, their settings and SMS/WhatsApp consent of this person in the business go with the membership.
        await tx.membership.delete({
          where: { tenantId_userId: { tenantId: f.tenantId, userId: auth.userId } },
        });
      }

      await applyContext(tx, { userId: auth.userId });
      await tx.$executeRaw`SELECT delete_own_account(${auth.userId}::uuid)`;
    });

    // To the OLD address, after the commit (nobody is told about a deletion that rolled back). No token, no link.
    await this.mail.send(templates.accountDeleted(email));
    return { deleted: true, businessesScheduled: scheduledNow };
  }
}
