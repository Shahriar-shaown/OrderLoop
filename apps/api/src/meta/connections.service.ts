import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ingestEvents,
  processSocialEvent,
  type JobQueue,
  type MetaEvent,
} from '@orderloop/automation';
import type {
  MetaOverview,
  MockConnectionBody,
  MockEventBody,
  MockEventResult,
  SocialConnection,
} from '@orderloop/contracts';
import { Database, type Tx } from '@orderloop/db';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { CredentialVault } from '../couriers/credential-vault.js';
import { META_EVENTS_QUEUE } from '../queue/queue.module.js';
import { graphProblem, MetaRuntime } from './meta.runtime.js';

type ConnectionRow = NonNullable<Awaited<ReturnType<Tx['socialConnection']['findFirst']>>>;

/** The connection as the API returns it. Never carries the token, only whether the account is usable. */
export function toConnection(row: ConnectionRow): SocialConnection {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.externalId,
    displayName: row.displayName,
    username: row.username,
    linkedPageId: row.linkedPageId,
    status: row.status,
    mock: row.mock,
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    connectedAt: row.createdAt.toISOString(),
    disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly runtime: MetaRuntime,
    private readonly vault: CredentialVault,
    @Inject(META_EVENTS_QUEUE) private readonly queue: JobQueue,
  ) {}

  async overview(auth: AuthContext): Promise<MetaOverview> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.socialConnection.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return {
        mode: this.runtime.mode,
        liveConfigured: this.runtime.liveConfigured,
        webhookUrl: this.runtime.mode === 'live' ? this.runtime.webhookUrl : null,
        scopes: [...this.runtime.scopes],
        // A disconnected account stays listed (with its status) so the screen can offer to connect it again.
        connections: rows.map(toConnection),
        openDrafts: await tx.socialDraft.count({
          where: { tenantId: auth.tenantId, status: 'needs_review' },
        }),
      };
    });
  }

  // ---- mock mode ------------------------------------------------------------------------------------------------------

  private requireMock(): void {
    // Not hidden behind a permission: in live mode (and in production, unless explicitly allowed) these simply do not exist.
    if (!this.runtime.mockEndpointsEnabled) throw ApiError.notFound();
  }

  async createMockConnection(
    auth: AuthContext,
    body: MockConnectionBody,
    ip: string | null,
  ): Promise<SocialConnection> {
    this.requireMock();
    const suffix = randomBytes(5).toString('hex');
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const row = await tx.socialConnection.create({
        data: {
          tenantId: auth.tenantId,
          provider: body.provider,
          // Cannot collide with a real Meta id, nor with another business's mock account.
          externalId: `mock_${suffix}`,
          displayName:
            body.displayName ??
            (body.provider === 'instagram' ? 'Mock Instagram shop' : 'Mock Facebook Page'),
          username: body.provider === 'instagram' ? `mock_shop_${suffix}` : null,
          mock: true,
          scopes: [],
          connectedById: auth.userId,
        },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'integration.connected',
        targetType: 'social_connection',
        targetId: row.id,
        metadata: { provider: row.provider, mock: true },
        ip,
      });
      return toConnection(row);
    });
  }

  /**
   * A synthetic customer message through the SAME pipeline a real webhook uses (`ingestEvents`: store, dedupe, queue), then
   * processed at once so the caller can see the draft. Signature verification is skipped only because this never comes from
   * Meta; the real webhook route is exercised separately with properly signed payloads.
   */
  async injectMockEvent(auth: AuthContext, body: MockEventBody): Promise<MockEventResult> {
    this.requireMock();
    const connection = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.socialConnection.findFirst({ where: { id: body.connectionId, tenantId: auth.tenantId } }),
    );
    if (!connection || !connection.mock || connection.status === 'disconnected')
      throw ApiError.notFound('Mock connection not found');
    const key = body.messageId ?? `mock_mid_${randomUUID()}`;
    const event: MetaEvent = {
      provider: connection.provider,
      accountId: connection.externalId,
      senderId: body.senderId,
      eventType: 'message',
      key,
      timestamp: body.timestamp ? new Date(body.timestamp) : this.runtime.now(),
      text: body.text?.trim() ? body.text : null,
      attachmentTypes: body.attachmentTypes ?? [],
    };
    const { events } = await ingestEvents(
      { db: this.db, queue: this.queue, log: () => undefined },
      [event],
    );
    const stored = events[0];
    if (!stored) throw ApiError.notFound('Mock connection not found');
    if (stored.status === 'received')
      await processSocialEvent(
        { db: this.db, log: () => undefined },
        { tenantId: auth.tenantId, eventId: stored.eventId },
      );
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const row = await tx.socialEvent.findFirstOrThrow({
        where: { id: stored.eventId, tenantId: auth.tenantId },
        select: { status: true },
      });
      const draft = await tx.socialDraft.findFirst({
        where: {
          tenantId: auth.tenantId,
          connectionId: connection.id,
          sourceEventIds: { array_contains: stored.eventId },
        },
        select: { id: true },
      });
      return {
        mode: this.runtime.mode,
        mock: true as const,
        eventId: stored.eventId,
        messageId: key,
        duplicate: stored.duplicate,
        status: row.status,
        draftId: draft?.id ?? null,
      };
    });
  }

  // ---- disconnect -----------------------------------------------------------------------------------------------------

  /** Stop receiving, forget the token, tell Meta (best effort). Repeating it changes nothing. */
  async disconnect(auth: AuthContext, id: string, ip: string | null): Promise<SocialConnection> {
    const row = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.socialConnection.findFirst({ where: { id, tenantId: auth.tenantId } }),
    );
    if (!row) throw ApiError.notFound('Connection not found');
    if (row.status === 'disconnected') return toConnection(row);

    // Best effort: a Page that cannot be unsubscribed (token already dead) is still disconnected here.
    if (
      !row.mock &&
      row.accessTokenEnc &&
      row.provider === 'facebook_page' &&
      this.runtime.mode === 'live'
    ) {
      try {
        const token = this.vault.decrypt(row.accessTokenEnc, {
          tenantId: auth.tenantId,
          provider: `meta_${row.provider}`,
        });
        await this.runtime.graph().unsubscribePage(row.externalId, token);
      } catch (error) {
        void graphProblem(error); // swallowed on purpose; nothing about it is logged beyond the kind
      }
    }
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const updated = await markDisconnected(tx, auth.tenantId, id);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'integration.disconnected',
        targetType: 'social_connection',
        targetId: id,
        metadata: { provider: row.provider, mock: row.mock },
        ip,
      });
      return toConnection(updated);
    });
  }
}

/** Disconnected and without a token: the one way a connection ends. */
export async function markDisconnected(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<ConnectionRow> {
  return tx.socialConnection.update({
    where: { id, tenantId },
    data: {
      status: 'disconnected',
      accessTokenEnc: null,
      tokenType: null,
      tokenExpiresAt: null,
      disconnectedAt: new Date(),
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
}
