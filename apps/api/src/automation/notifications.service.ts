import { Injectable } from '@nestjs/common';
import {
  AUTOMATION_KINDS,
  DEFAULT_PREFERENCE,
  normalizeBdPhone,
  type MessagingConsents,
  type Notification,
  type NotificationPage,
  type NotificationPreferences,
  type NotificationQuery,
  type PushDevice,
  type ReadAllResult,
  type RegisterPushDeviceBody,
  type UnreadCount,
  type UpdateMessagingConsentBody,
  type UpdateNotificationPreferencesBody,
} from '@orderloop/contracts';
import { Database } from '@orderloop/db';
import { roleCanReceive } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import type { AuthContext } from '../common/endpoint.js';
import { toConsent, toNotification } from './automation.mapper.js';
import { AutomationRuntime } from './automation.runtime.js';

/** Everything here is about the caller themselves: their notifications, their channel choices, their phones, their consent. */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly runtime: AutomationRuntime,
  ) {}

  private ctx(auth: AuthContext) {
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  // ---- the list ------------------------------------------------------------------------------------------------------

  async list(auth: AuthContext, query: NotificationQuery): Promise<NotificationPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.db.withContext(this.ctx(auth), (tx) =>
      tx.notification.findMany({
        where: {
          tenantId: auth.tenantId,
          userId: auth.userId,
          inApp: true,
          ...(query.unread ? { readAt: null } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toNotification),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  unreadCount(auth: AuthContext): Promise<UnreadCount> {
    return this.db.withContext(this.ctx(auth), async (tx) => ({
      count: await tx.notification.count({
        where: { tenantId: auth.tenantId, userId: auth.userId, inApp: true, readAt: null },
      }),
    }));
  }

  /** Marks one of the caller's own notifications read. Someone else's, or none, is 404; reading twice keeps the first time. */
  markRead(auth: AuthContext, id: string): Promise<Notification> {
    return this.db.withContext(this.ctx(auth), async (tx) => {
      await tx.notification.updateMany({
        where: { id, tenantId: auth.tenantId, userId: auth.userId, inApp: true, readAt: null },
        data: { readAt: this.runtime.now() },
      });
      const row = await tx.notification.findFirst({
        where: { id, tenantId: auth.tenantId, userId: auth.userId, inApp: true },
      });
      if (!row) throw ApiError.notFound('Notification not found');
      return toNotification(row);
    });
  }

  markAllRead(auth: AuthContext): Promise<ReadAllResult> {
    return this.db.withContext(this.ctx(auth), async (tx) => {
      const r = await tx.notification.updateMany({
        where: { tenantId: auth.tenantId, userId: auth.userId, inApp: true, readAt: null },
        data: { readAt: this.runtime.now() },
      });
      return { updated: r.count };
    });
  }

  // ---- channel preferences -------------------------------------------------------------------------------------------

  getPreferences(auth: AuthContext): Promise<NotificationPreferences> {
    return this.db.withContext(this.ctx(auth), (tx) => this.readPreferences(tx, auth));
  }

  private async readPreferences(
    tx: Parameters<Parameters<Database['withContext']>[1]>[0],
    auth: AuthContext,
  ): Promise<NotificationPreferences> {
    const rows = await tx.notificationPreference.findMany({
      where: { tenantId: auth.tenantId, userId: auth.userId },
    });
    const byKind = new Map(rows.map((r) => [r.kind, r]));
    return {
      items: AUTOMATION_KINDS.map((kind) => {
        const r = byKind.get(kind);
        return {
          kind,
          inApp: r?.inApp ?? DEFAULT_PREFERENCE.inApp,
          push: r?.push ?? DEFAULT_PREFERENCE.push,
          email: r?.email ?? DEFAULT_PREFERENCE.email,
          available: roleCanReceive(auth.role, kind),
        };
      }),
    };
  }

  updatePreferences(
    auth: AuthContext,
    body: UpdateNotificationPreferencesBody,
  ): Promise<NotificationPreferences> {
    return this.db.withContext(this.ctx(auth), async (tx) => {
      for (const item of body.items) {
        const data = {
          ...(item.inApp !== undefined ? { inApp: item.inApp } : {}),
          ...(item.push !== undefined ? { push: item.push } : {}),
          ...(item.email !== undefined ? { email: item.email } : {}),
        };
        await tx.notificationPreference.upsert({
          where: {
            tenantId_userId_kind: { tenantId: auth.tenantId, userId: auth.userId, kind: item.kind },
          },
          create: {
            tenantId: auth.tenantId,
            userId: auth.userId,
            kind: item.kind,
            inApp: DEFAULT_PREFERENCE.inApp,
            push: DEFAULT_PREFERENCE.push,
            email: DEFAULT_PREFERENCE.email,
            ...data,
          },
          update: data,
        });
      }
      return this.readPreferences(tx, auth);
    });
  }

  // ---- push devices --------------------------------------------------------------------------------------------------

  /** An upsert by token (the database function also moves a token that belonged to someone else, e.g. a phone that changed hands). */
  registerDevice(auth: AuthContext, body: RegisterPushDeviceBody): Promise<PushDevice> {
    return this.db.withContext(this.ctx(auth), async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; platform: 'ios' | 'android'; provider: 'dev' | 'expo'; last_seen_at: Date }[]
      >`SELECT * FROM upsert_push_device(${auth.userId}::uuid, ${body.token}, ${body.platform}::"PushPlatform", ${this.runtime.config.PUSH_PROVIDER}::"PushProviderKind")`;
      const r = rows[0]!;
      return {
        id: r.id,
        platform: r.platform,
        provider: r.provider,
        lastSeenAt: r.last_seen_at.toISOString(),
      };
    });
  }

  /** Forget a token, only if it is the caller's own. Removing one that is not there is not an error. */
  removeDevice(auth: AuthContext, token: string): Promise<Record<string, never>> {
    return this.db.withContext(this.ctx(auth), async (tx) => {
      await tx.pushDevice.deleteMany({ where: { token, userId: auth.userId } });
      return {};
    });
  }

  // ---- messaging consent ---------------------------------------------------------------------------------------------

  getConsents(auth: AuthContext): Promise<MessagingConsents> {
    return this.db.withContext(this.ctx(auth), (tx) => this.readConsents(tx, auth));
  }

  private async readConsents(
    tx: Parameters<Parameters<Database['withContext']>[1]>[0],
    auth: AuthContext,
  ): Promise<MessagingConsents> {
    const rows = await tx.messagingConsent.findMany({
      where: { tenantId: auth.tenantId, userId: auth.userId },
    });
    return {
      items: (['sms', 'whatsapp'] as const).map((channel) =>
        toConsent(
          channel,
          this.runtime.channels[channel],
          rows.find((r) => r.channel === channel),
        ),
      ),
    };
  }

  /** Grant (with a number) or revoke the caller's own consent. Nobody can consent for someone else: it is keyed to the caller. */
  updateConsent(
    auth: AuthContext,
    body: UpdateMessagingConsentBody,
    ip: string | null,
  ): Promise<MessagingConsents> {
    let phone: string | null = null;
    if (body.granted) {
      if (!this.runtime.channels[body.channel])
        throw new ApiError(
          'channel_not_configured',
          `${body.channel === 'sms' ? 'SMS' : 'WhatsApp'} is not set up on this server`,
        );
      phone = normalizeBdPhone(body.phone ?? '');
      if (!phone)
        throw new ApiError('validation_failed', 'Request validation failed', [
          { path: 'body.phone', message: 'Enter a valid Bangladeshi mobile number' },
        ]);
    }
    return this.db.withContext(this.ctx(auth), async (tx) => {
      const now = this.runtime.now();
      const where = {
        tenantId_userId_channel: {
          tenantId: auth.tenantId,
          userId: auth.userId,
          channel: body.channel,
        },
      };
      const existing = await tx.messagingConsent.findUnique({ where });
      if (body.granted) {
        const already = existing && !existing.revokedAt && existing.phone === phone;
        if (!already) {
          await tx.messagingConsent.upsert({
            where,
            create: {
              tenantId: auth.tenantId,
              userId: auth.userId,
              channel: body.channel,
              phone: phone!,
              grantedAt: now,
              source: 'app',
            },
            update: { phone: phone!, grantedAt: now, revokedAt: null, source: 'app' },
          });
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'messaging.consent_granted',
            targetType: 'messaging_consent',
            metadata: { channel: body.channel },
            ip,
          });
        }
      } else if (existing && !existing.revokedAt) {
        await tx.messagingConsent.update({ where, data: { revokedAt: now } });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'messaging.consent_revoked',
          targetType: 'messaging_consent',
          metadata: { channel: body.channel },
          ip,
        });
      }
      return this.readConsents(tx, auth);
    });
  }
}
