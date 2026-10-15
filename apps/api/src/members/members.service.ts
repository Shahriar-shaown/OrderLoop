import { Inject, Injectable } from '@nestjs/common';
import type {
  Invitation,
  InvitationSummary,
  InviteBody,
  Member,
  Role,
  UpdateMemberBody,
} from '@orderloop/contracts';
import { Database, type Tx } from '@orderloop/db';
import { can, canAssignRole, canManageMemberWithRole } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { TokenService } from '../auth/token.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { MailService } from '../mail/mail.service.js';
import { templates } from '../mail/templates.js';

const INVITE_TTL_MS = 7 * 86_400_000;

type MemberRow = {
  id: string;
  userId: string;
  role: Role;
  createdAt: Date;
  user: { email: string; name: string };
};

const toMember = (m: MemberRow): Member => ({
  id: m.id,
  userId: m.userId,
  email: m.user.email,
  name: m.user.name,
  role: m.role,
  joinedAt: m.createdAt.toISOString(),
});

@Injectable()
export class MembersService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  list(auth: AuthContext): Promise<Member[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.membership.findMany({
        where: { tenantId: auth.tenantId },
        include: { user: { select: { email: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toMember);
    });
  }

  async invite(auth: AuthContext, body: InviteBody, ip: string | null): Promise<Invitation> {
    if (!canAssignRole(auth.role, body.role))
      throw ApiError.forbidden(`Your role cannot invite someone as ${body.role}`);

    const secret = this.tokens.newOpaqueToken();
    const token = `inv_${auth.tenantId}_${secret}`;
    const invitation = await this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        // Unverified accounts cannot send email on our behalf: stops a throwaway sign-up from being used to spam.
        const inviter = await tx.user.findUnique({
          where: { id: auth.userId },
          select: { emailVerifiedAt: true },
        });
        if (!inviter?.emailVerifiedAt)
          throw new ApiError(
            403,
            'email_not_verified',
            'Verify your email address before inviting people',
          );
        const existing = await tx.user.findUnique({
          where: { email: body.email },
          select: { id: true },
        });
        if (
          existing &&
          (await tx.membership.findUnique({
            where: { tenantId_userId: { tenantId: auth.tenantId, userId: existing.id } },
          }))
        ) {
          throw ApiError.conflict('That person is already a member');
        }
        // A newer invitation supersedes any pending one for the same address.
        await tx.invitation.updateMany({
          where: { tenantId: auth.tenantId, email: body.email, acceptedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        const created = await tx.invitation.create({
          data: {
            tenantId: auth.tenantId,
            email: body.email,
            role: body.role,
            tokenHash: this.tokens.hashToken(token),
            invitedById: auth.userId,
            expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          },
        });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'member.invited',
          targetType: 'invitation',
          targetId: created.id,
          metadata: { role: body.role },
          ip,
        });
        return created;
      },
    );

    // Sent after commit; the token is never returned to the inviter, who could otherwise accept it as the invitee.
    await this.mail.send(
      templates.invitation(body.email, this.config.WEB_ORIGINS[0]!, token, body.role),
    );
    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  async listInvitations(auth: AuthContext): Promise<InvitationSummary[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.invitation.findMany({
        where: {
          tenantId: auth.tenantId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        expiresAt: r.expiresAt.toISOString(),
        invitedById: r.invitedById,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  async revokeInvitation(
    auth: AuthContext,
    invitationId: string,
    ip: string | null,
  ): Promise<void> {
    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const invitation = await tx.invitation.findFirst({
        where: { id: invitationId, tenantId: auth.tenantId, acceptedAt: null, revokedAt: null },
      });
      if (!invitation) throw ApiError.notFound('Invitation not found');
      // You may only withdraw an invitation for a role you could have granted yourself.
      if (!canAssignRole(auth.role, invitation.role))
        throw ApiError.forbidden('Your role cannot revoke this invitation');
      await tx.invitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'member.invitation_revoked',
        targetType: 'invitation',
        targetId: invitation.id,
        ip,
      });
    });
  }

  /** An invitation carries its inviter's authority; when that authority ends, so do their pending invitations. */
  private revokePendingInvitationsBy(tx: Tx, tenantId: string, inviterId: string) {
    return tx.invitation.updateMany({
      where: { tenantId, invitedById: inviterId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Locks the tenant's owner rows so two concurrent changes cannot both pass the last-owner check, then
   * re-reads the actor's role. The guard's copy may be stale by now (the actor could have been demoted
   * while this request waited for the lock), so the authoritative role is the one read under the lock.
   */
  private async lockAndAuthorise(
    tx: Tx,
    auth: AuthContext,
  ): Promise<{ owners: number; actorRole: Role }> {
    const owners = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM memberships WHERE tenant_id = ${auth.tenantId}::uuid AND role = 'OWNER' FOR UPDATE`;
    const actor = await tx.membership.findUnique({
      where: { tenantId_userId: { tenantId: auth.tenantId, userId: auth.userId } },
    });
    if (!actor || !can(actor.role, 'members:manage')) throw ApiError.forbidden();
    return { owners: owners.length, actorRole: actor.role };
  }

  async updateRole(
    auth: AuthContext,
    memberId: string,
    body: UpdateMemberBody,
    ip: string | null,
  ): Promise<Member> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const { owners, actorRole } = await this.lockAndAuthorise(tx, auth);
      const target = await tx.membership.findFirst({
        where: { id: memberId, tenantId: auth.tenantId },
        include: { user: { select: { email: true, name: true } } },
      });
      if (!target) throw ApiError.notFound('Member not found');
      if (!canManageMemberWithRole(actorRole, target.role) || !canAssignRole(actorRole, body.role))
        throw ApiError.forbidden('Your role cannot make this change');
      if (target.role === 'OWNER' && body.role !== 'OWNER' && owners <= 1)
        throw new ApiError(409, 'last_owner', 'A tenant must keep at least one owner');
      if (target.role === body.role) return toMember(target);

      const updated = await tx.membership.update({
        where: { id: target.id },
        data: { role: body.role },
        include: { user: { select: { email: true, name: true } } },
      });
      await this.revokePendingInvitationsBy(tx, auth.tenantId, target.userId);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'member.role_changed',
        targetType: 'membership',
        targetId: target.id,
        metadata: { from: target.role, to: body.role },
        ip,
      });
      return toMember(updated);
    });
  }

  async remove(auth: AuthContext, memberId: string, ip: string | null): Promise<void> {
    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const { owners, actorRole } = await this.lockAndAuthorise(tx, auth);
      const target = await tx.membership.findFirst({
        where: { id: memberId, tenantId: auth.tenantId },
      });
      if (!target) throw ApiError.notFound('Member not found');
      if (!canManageMemberWithRole(actorRole, target.role))
        throw ApiError.forbidden('Your role cannot remove this member');
      if (target.role === 'OWNER' && owners <= 1)
        throw new ApiError(409, 'last_owner', 'A tenant must keep at least one owner');

      await tx.membership.delete({ where: { id: target.id } });
      await this.revokePendingInvitationsBy(tx, auth.tenantId, target.userId);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'member.removed',
        targetType: 'membership',
        targetId: target.id,
        metadata: { userId: target.userId, role: target.role },
        ip,
      });
    });
  }
}
