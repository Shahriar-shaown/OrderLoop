import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  Password,
  type AcceptInvitationBody,
  type AuthResult,
  type LoginBody,
  type Me,
  type RegisterBody,
  type Role,
  type TenantInfo,
} from '@orderloop/contracts';
import { Database, isUniqueViolation, type Tx } from '@orderloop/db';
import { canAssignRole, permissionsFor } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import { uuidv7 } from '../common/uuid.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordService } from './password.service.js';
import { SessionService, type ClientMeta } from './session.service.js';
import { TokenService } from './token.service.js';

/** AuthResult as issued internally: always carries the refresh token; the transport layer decides how to deliver it. */
export type Issued = AuthResult & { refreshToken?: string };

interface Grant {
  user: { id: string; email: string; name: string };
  tenant: { id: string; name: string };
  role: Role;
  sessionId: string;
  memberships: { tenantId: string; role: Role }[];
  refreshToken?: string;
}

const INVITE_TOKEN_RE =
  /^inv_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{20,}$/;
const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly throttle: LoginThrottleService,
  ) {}

  private async toResult(grant: Grant): Promise<Issued> {
    const accessToken = await this.tokens.signAccessToken({
      userId: grant.user.id,
      tenantId: grant.tenant.id,
      role: grant.role,
      sessionId: grant.sessionId,
    });
    return {
      accessToken,
      expiresIn: this.tokens.accessTtlSeconds,
      ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
      user: grant.user,
      tenant: grant.tenant,
      role: grant.role,
      memberships: grant.memberships,
    };
  }

  private async loadGrant(
    tx: Tx,
    input: {
      userId: string;
      tenantId: string;
      role: Role;
      sessionId: string;
      refreshToken?: string;
    },
  ): Promise<Grant> {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { id: true, email: true, name: true },
    });
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: input.tenantId },
      select: { id: true, name: true },
    });
    const memberships = await tx.membership.findMany({
      where: { userId: input.userId },
      select: { tenantId: true, role: true },
      orderBy: { createdAt: 'desc' },
    });
    return {
      user,
      tenant,
      role: input.role,
      sessionId: input.sessionId,
      memberships,
      ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
    };
  }

  async register(body: RegisterBody, meta: ClientMeta): Promise<Issued> {
    const passwordHash = await this.passwords.hash(body.password);
    // Ids are generated here so the tenant context exists before the tenant row does.
    const tenantId = uuidv7();
    const userId = uuidv7();
    try {
      const grant = await this.db.withContext({ tenantId, userId }, async (tx) => {
        await tx.user.create({
          data: { id: userId, email: body.email, name: body.name, passwordHash },
        });
        await tx.tenant.create({ data: { id: tenantId, name: body.tenantName } });
        await tx.membership.create({ data: { tenantId, userId, role: 'OWNER' } });
        const session = await this.sessions.create(tx, { userId, tenantId, ...meta });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: userId,
          action: 'tenant.created',
          targetType: 'tenant',
          targetId: tenantId,
          ip: meta.ip ?? null,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: userId,
          action: 'auth.register',
          targetType: 'user',
          targetId: userId,
          ip: meta.ip ?? null,
        });
        return this.loadGrant(tx, {
          userId,
          tenantId,
          role: 'OWNER',
          sessionId: session.sessionId,
          refreshToken: session.refreshToken,
        });
      });
      return this.toResult(grant);
    } catch (error) {
      if (isUniqueViolation(error, 'email'))
        throw ApiError.conflict('An account with this email already exists');
      throw error;
    }
  }

  async login(body: LoginBody, meta: ClientMeta): Promise<Issued> {
    await this.throttle.assertNotLocked(body.email, meta.ip);
    const user = await this.db.global.user.findUnique({ where: { email: body.email } });
    const valid =
      user && !user.disabledAt
        ? await this.passwords.verify(user.passwordHash, body.password)
        : await this.passwords.verifyDummy(body.password);
    if (!user || !valid) {
      await this.throttle.recordFailure(body.email, meta.ip);
      await this.audit.recordOutsideTenant({
        action: 'auth.login_failed',
        metadata: { emailHash: shortHash(body.email) },
        ip: meta.ip ?? null,
      });
      throw ApiError.invalidCredentials();
    }

    const memberships = await this.db.withContext({ userId: user.id }, (tx) =>
      tx.membership.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } }),
    );
    const chosen = body.tenantId
      ? memberships.find((m) => m.tenantId === body.tenantId)
      : memberships[0];
    if (!chosen)
      throw ApiError.forbidden(
        body.tenantId ? 'You are not a member of that tenant' : 'This account has no active tenant',
      );

    const tenantId = chosen.tenantId;
    const grant = await this.db.withContext({ tenantId, userId: user.id }, async (tx) => {
      const session = await this.sessions.create(tx, { userId: user.id, tenantId, ...meta });
      await this.audit.record(tx, {
        tenantId,
        actorUserId: user.id,
        action: 'auth.login',
        targetType: 'session',
        targetId: session.sessionId,
        ip: meta.ip ?? null,
      });
      return this.loadGrant(tx, {
        userId: user.id,
        tenantId,
        role: chosen.role,
        sessionId: session.sessionId,
        refreshToken: session.refreshToken,
      });
    });
    await this.throttle.clear(body.email, meta.ip);
    return this.toResult(grant);
  }

  async refresh(rawToken: string, meta: ClientMeta): Promise<Issued> {
    const rotated = await this.sessions.rotate(rawToken, meta);
    const grant = await this.db.withContext(
      { tenantId: rotated.tenantId, userId: rotated.userId },
      (tx) =>
        this.loadGrant(tx, {
          userId: rotated.userId,
          tenantId: rotated.tenantId,
          role: rotated.role,
          sessionId: rotated.sessionId,
          refreshToken: rotated.refreshToken,
        }),
    );
    return this.toResult(grant);
  }

  async logout(
    auth: { userId: string; tenantId: string; sessionId: string },
    meta: ClientMeta,
  ): Promise<void> {
    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      await this.sessions.revoke(tx, auth.sessionId, 'logout');
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'auth.logout',
        targetType: 'session',
        targetId: auth.sessionId,
        ip: meta.ip ?? null,
      });
    });
  }

  async switchTenant(
    auth: { userId: string; sessionId: string },
    tenantId: string,
    meta: ClientMeta,
  ): Promise<Issued> {
    const grant = await this.db.withContext({ tenantId, userId: auth.userId }, async (tx) => {
      const membership = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: auth.userId } },
      });
      // Same answer whether the tenant does not exist or the user is not in it.
      if (!membership) throw ApiError.forbidden('You are not a member of that tenant');
      await tx.session.updateMany({
        where: { id: auth.sessionId, userId: auth.userId, revokedAt: null },
        data: { activeTenantId: tenantId },
      });
      await this.audit.record(tx, {
        tenantId,
        actorUserId: auth.userId,
        action: 'auth.switch_tenant',
        targetType: 'session',
        targetId: auth.sessionId,
        ip: meta.ip ?? null,
      });
      return this.loadGrant(tx, {
        userId: auth.userId,
        tenantId,
        role: membership.role,
        sessionId: auth.sessionId,
      });
    });
    return this.toResult(grant);
  }

  async acceptInvitation(body: AcceptInvitationBody, meta: ClientMeta): Promise<Issued> {
    const match = INVITE_TOKEN_RE.exec(body.token);
    if (!match)
      throw new ApiError(400, 'invitation_invalid', 'Invitation is invalid or has expired');
    const tenantId = match[1]!;
    const tokenHash = this.tokens.hashToken(body.token);
    const invalid = () =>
      new ApiError(400, 'invitation_invalid', 'Invitation is invalid or has expired');

    // The tenant id inside the token puts us in the right tenant context without any cross-tenant lookup.
    const invitation = await this.db.withContext({ tenantId }, (tx) =>
      tx.invitation.findUnique({ where: { tokenHash } }),
    );
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= new Date()
    )
      throw invalid();

    const existing = await this.db.global.user.findUnique({ where: { email: invitation.email } });
    let newUser: { id: string; passwordHash: string; name: string } | undefined;
    if (existing) {
      await this.throttle.assertNotLocked(existing.email, meta.ip);
      if (
        existing.disabledAt ||
        !(await this.passwords.verify(existing.passwordHash, body.password))
      ) {
        await this.throttle.recordFailure(existing.email, meta.ip);
        throw ApiError.invalidCredentials();
      }
    } else {
      const policy = Password.safeParse(body.password);
      if (!policy.success)
        throw new ApiError(400, 'validation_failed', 'Request validation failed', [
          { path: 'body.password', message: policy.error.issues[0]?.message ?? 'Invalid password' },
        ]);
      if (!body.name)
        throw new ApiError(400, 'validation_failed', 'Request validation failed', [
          { path: 'body.name', message: 'Name is required to create an account' },
        ]);
      newUser = {
        id: uuidv7(),
        passwordHash: await this.passwords.hash(body.password),
        name: body.name,
      };
    }
    const userId = existing?.id ?? newUser!.id;

    try {
      const grant = await this.db.withContext({ tenantId, userId }, async (tx) => {
        // An invitation carries its inviter's authority. If the inviter has left, or no longer holds a role
        // that may grant this one, the invitation is void; revoke it for good (committed, so not thrown here).
        const inviter = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId, userId: invitation.invitedById } },
        });
        if (!inviter || !canAssignRole(inviter.role, invitation.role)) {
          await tx.invitation.updateMany({
            where: { id: invitation.id, acceptedAt: null, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          return null;
        }
        // Atomic claim: only one concurrent acceptance can flip acceptedAt from null.
        const claimed = await tx.invitation.updateMany({
          where: { id: invitation.id, acceptedAt: null, revokedAt: null },
          data: { acceptedAt: new Date() },
        });
        if (claimed.count !== 1) throw invalid();
        if (newUser)
          await tx.user.create({
            data: {
              id: newUser.id,
              email: invitation.email,
              name: newUser.name,
              passwordHash: newUser.passwordHash,
            },
          });
        await tx.membership.create({ data: { tenantId, userId, role: invitation.role } });
        const session = await this.sessions.create(tx, { userId, tenantId, ...meta });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: userId,
          action: 'member.joined',
          targetType: 'user',
          targetId: userId,
          metadata: { role: invitation.role, invitationId: invitation.id },
          ip: meta.ip ?? null,
        });
        return this.loadGrant(tx, {
          userId,
          tenantId,
          role: invitation.role,
          sessionId: session.sessionId,
          refreshToken: session.refreshToken,
        });
      });
      if (!grant) throw invalid();
      if (existing) await this.throttle.clear(existing.email, meta.ip);
      return this.toResult(grant);
    } catch (error) {
      if (isUniqueViolation(error, 'email'))
        throw ApiError.conflict('An account with this email already exists');
      if (isUniqueViolation(error))
        throw ApiError.conflict('You are already a member of this tenant');
      throw error;
    }
  }

  async me(auth: { userId: string; tenantId: string; role: Role }): Promise<Me> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const grant = await this.loadGrant(tx, {
        userId: auth.userId,
        tenantId: auth.tenantId,
        role: auth.role,
        sessionId: '',
      });
      return {
        user: grant.user,
        tenant: grant.tenant,
        role: auth.role,
        permissions: [...permissionsFor(auth.role)],
        memberships: grant.memberships,
      };
    });
  }

  async tenant(tenantId: string): Promise<TenantInfo> {
    const t = await this.db.withContext({ tenantId }, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId } }),
    );
    if (!t) throw ApiError.notFound('Tenant not found');
    return { id: t.id, name: t.name, createdAt: t.createdAt.toISOString() };
  }
}
