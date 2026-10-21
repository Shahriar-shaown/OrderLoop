import { Injectable } from '@nestjs/common';
import { deletionCode, parseSignedRequest } from '@orderloop/automation';
import { Database } from '@orderloop/db';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import { markDisconnected } from './connections.service.js';
import { MetaRuntime } from './meta.runtime.js';

/**
 * Meta's two required callbacks. Both arrive as `signed_request` (HMAC-SHA256 with the app secret), carry the app-scoped user
 * id, and must be answered fast; deleting is immediate here, so there is nothing to wait for.
 */
@Injectable()
export class CallbacksService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly runtime: MetaRuntime,
  ) {}

  /** The verified user id, or an error. Without the app secret (no Meta app configured) the callbacks do not exist. */
  private subject(signedRequest: string): string {
    const secret = this.runtime.appSecret;
    if (!secret) throw ApiError.notFound();
    const payload = parseSignedRequest(signedRequest, secret);
    const userId = payload?.['user_id'];
    if (!payload || typeof userId !== 'string' || !/^[\w-]{1,64}$/.test(userId))
      throw new ApiError('meta_oauth_invalid', 'The signed request could not be verified.');
    return userId;
  }

  /** The person removed the app: disconnect what they connected and delete the stored tokens. Events and drafts stay until they expire. */
  async deauthorize(signedRequest: string): Promise<Record<string, never>> {
    const userId = this.subject(signedRequest);
    const targets = (await this.db.metaDeletionTargets(userId)).filter(
      (t) => t.reason === 'authoriser',
    );
    for (const t of targets)
      await this.db.withContext({ tenantId: t.tenantId }, async (tx) => {
        const row = await tx.socialConnection.findFirst({
          where: { id: t.connectionId, tenantId: t.tenantId },
        });
        if (!row || row.status === 'disconnected') return;
        await markDisconnected(tx, t.tenantId, t.connectionId);
        await this.audit.record(tx, {
          tenantId: t.tenantId,
          actorUserId: null,
          action: 'integration.disconnected',
          targetType: 'social_connection',
          targetId: t.connectionId,
          metadata: { reason: 'meta_deauthorize' },
        });
      });
    return {};
  }

  /**
   * A data deletion request: for a person who connected accounts, disconnect them and delete every stored event and draft of
   * those connections; for a customer id that appears in conversations, delete that customer's events and drafts. Orders a
   * business already made stay (they are the business's own records and hold no chat text).
   */
  async deleteData(signedRequest: string): Promise<{ url: string; confirmation_code: string }> {
    const userId = this.subject(signedRequest);
    const targets = await this.db.metaDeletionTargets(userId);
    for (const t of targets)
      await this.db.withContext({ tenantId: t.tenantId }, async (tx) => {
        const bySender = t.reason === 'sender' ? { senderId: userId } : {};
        await tx.socialDraft.deleteMany({
          where: { tenantId: t.tenantId, connectionId: t.connectionId, ...bySender },
        });
        await tx.socialEvent.deleteMany({
          where: { tenantId: t.tenantId, connectionId: t.connectionId, ...bySender },
        });
        if (t.reason === 'authoriser') {
          const row = await tx.socialConnection.findFirst({
            where: { id: t.connectionId, tenantId: t.tenantId },
          });
          if (row && row.status !== 'disconnected')
            await markDisconnected(tx, t.tenantId, t.connectionId);
        }
        await this.audit.record(tx, {
          tenantId: t.tenantId,
          actorUserId: null,
          action: 'integration.data_deleted',
          targetType: 'social_connection',
          targetId: t.connectionId,
          metadata: { reason: 'meta_data_deletion', scope: t.reason },
        });
      });
    const code = deletionCode(userId, this.runtime.appSecret!);
    return {
      url: `${this.runtime.dataDeletionUrl}?code=${code}`,
      confirmation_code: code,
    };
  }
}
