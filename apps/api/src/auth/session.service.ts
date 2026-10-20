import { Inject, Injectable } from '@nestjs/common';
import type { Role } from '@orderloop/contracts';
import { applyContext, Database, type Tx } from '@orderloop/db';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { ApiError } from '../common/api-error.js';
import { AuditService } from '../audit/audit.service.js';
import { TokenService } from './token.service.js';

/** A session can never outlive this, however often it is refreshed. */
const SESSION_MAX_DAYS = 90;
const DAY_MS = 86_400_000;

export interface ClientMeta {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export interface Rotated {
  userId: string;
  tenantId: string;
  sessionId: string;
  role: Role;
  refreshToken: string;
}

type RotateOutcome =
  | { kind: 'ok'; rotated: Rotated }
  | { kind: 'invalid' }
  | { kind: 'ended' }
  | { kind: 'reuse' }
  | { kind: 'tenant_changed' };

@Injectable()
export class SessionService {
  constructor(
    private readonly db: Database,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Create a session plus its first refresh token inside the caller's transaction. */
  async create(
    tx: Tx,
    input: { userId: string; tenantId: string; expiresAt?: Date } & ClientMeta,
  ): Promise<{ sessionId: string; refreshToken: string }> {
    const session = await tx.session.create({
      data: {
        userId: input.userId,
        activeTenantId: input.tenantId,
        expiresAt: input.expiresAt ?? new Date(Date.now() + SESSION_MAX_DAYS * DAY_MS),
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      },
    });
    return {
      sessionId: session.id,
      refreshToken: (await this.issueRefreshToken(tx, session.id, session.expiresAt)).token,
    };
  }

  private async issueRefreshToken(
    tx: Tx,
    sessionId: string,
    sessionExpiresAt: Date,
  ): Promise<{ token: string; id: string }> {
    const token = this.tokens.newOpaqueToken();
    const ttl = Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * DAY_MS;
    const row = await tx.refreshToken.create({
      data: {
        sessionId,
        tokenHash: this.tokens.hashToken(token),
        expiresAt: new Date(Math.min(ttl, sessionExpiresAt.getTime())),
      },
      select: { id: true },
    });
    return { token, id: row.id };
  }

  async revoke(tx: Tx, sessionId: string, reason: string): Promise<void> {
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Was this already-exchanged token presented again within the grace window, with its successor still unused? */
  private async isRetry(
    tx: Tx,
    row: { usedAt: Date | null; replacedById: string | null },
    now: Date,
  ): Promise<boolean> {
    const graceMs = this.config.REFRESH_REUSE_GRACE_SECONDS * 1000;
    if (!row.usedAt || !row.replacedById || now.getTime() - row.usedAt.getTime() >= graceMs)
      return false;
    const successor = await tx.refreshToken.findUnique({
      where: { id: row.replacedById },
      select: { usedAt: true },
    });
    return successor !== null && successor.usedAt === null;
  }

  /**
   * Exchange a refresh token for a new one (rotation). Each token works exactly once; presenting a
   * token that was already exchanged is treated as theft and revokes the whole session, except for a
   * short grace window: a client whose response was lost retries with the token it still holds, and
   * gets a fresh token as long as the token issued the first time has not been used yet.
   */
  async rotate(rawToken: string, meta: ClientMeta, expectedTenantId?: string): Promise<Rotated> {
    const tokenHash = this.tokens.hashToken(rawToken);

    // The decision is committed before any error is thrown, otherwise a rollback would undo the revocation.
    const outcome = await this.db.withContext({}, async (tx): Promise<RotateOutcome> => {
      const row = await tx.refreshToken.findUnique({
        where: { tokenHash },
        include: { session: true },
      });
      if (!row) return { kind: 'invalid' };
      const session = row.session;
      const now = new Date();

      if (session.revokedAt) return { kind: 'ended' };

      const reuse = async (): Promise<RotateOutcome> => {
        await this.revoke(tx, session.id, 'refresh_token_reuse');
        await applyContext(tx, { tenantId: session.activeTenantId });
        await this.audit.record(tx, {
          tenantId: session.activeTenantId,
          actorUserId: session.userId,
          action: 'auth.token_reuse_detected',
          targetType: 'session',
          targetId: session.id,
          ip: meta.ip ?? null,
        });
        return { kind: 'reuse' };
      };

      let retry = row.usedAt !== null && (await this.isRetry(tx, row, now));
      let successorId = row.replacedById;
      if (row.usedAt && !retry) return reuse();
      if (row.expiresAt <= now || session.expiresAt <= now) return { kind: 'ended' };
      // The web cookie is shared by all tabs: a client that expects another tenant must not be moved silently.
      if (expectedTenantId && expectedTenantId !== session.activeTenantId)
        return { kind: 'tenant_changed' };

      await applyContext(tx, { tenantId: session.activeTenantId, userId: session.userId });
      const [membership, user] = await Promise.all([
        tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: session.activeTenantId, userId: session.userId } },
        }),
        tx.user.findUnique({ where: { id: session.userId }, select: { disabledAt: true } }),
      ]);
      if (!membership || !user || user.disabledAt) {
        await this.revoke(tx, session.id, 'membership_revoked');
        return { kind: 'ended' };
      }

      if (!retry) {
        // Compare-and-set: of two concurrent exchanges only one can flip usedAt from null.
        const claimed = await tx.refreshToken.updateMany({
          where: { id: row.id, usedAt: null },
          data: { usedAt: now },
        });
        if (claimed.count === 0) {
          // Lost the race (a second tab refreshed the same instant): judge it like any other retry.
          const winner = await tx.refreshToken.findUniqueOrThrow({ where: { id: row.id } });
          retry = await this.isRetry(tx, winner, now);
          if (!retry) return reuse();
          successorId = winner.replacedById;
        }
      }
      if (retry && successorId) {
        // Burn the successor handed out the first time, so two live chains never exist: using it later is reuse.
        await tx.refreshToken.updateMany({
          where: { id: successorId, usedAt: null },
          data: { usedAt: now },
        });
      }

      const next = await this.issueRefreshToken(tx, session.id, session.expiresAt);
      await tx.refreshToken.update({ where: { id: row.id }, data: { replacedById: next.id } });
      return {
        kind: 'ok',
        rotated: {
          userId: session.userId,
          tenantId: session.activeTenantId,
          sessionId: session.id,
          role: membership.role,
          refreshToken: next.token,
        },
      };
    });

    switch (outcome.kind) {
      case 'ok':
        return outcome.rotated;
      case 'reuse':
        throw new ApiError(
          'token_reuse_detected',
          'Refresh token was already used; the session has been revoked. Sign in again.',
        );
      case 'tenant_changed':
        throw new ApiError(
          'tenant_changed',
          'This session belongs to another business than the one you were using',
        );
      case 'ended':
        throw new ApiError('token_expired', 'Session has ended. Sign in again.');
      default:
        throw new ApiError('unauthorized', 'Invalid refresh token');
    }
  }
}
