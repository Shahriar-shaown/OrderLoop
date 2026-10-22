import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  reconcileWaitingTikTokOrders,
  syncTikTokConnection,
  type TikTokMetrics,
} from '@orderloop/automation';
import { tiktokOrderSink } from '@orderloop/catalog';
import type {
  TikTokConnection,
  TikTokMockConnectionBody,
  TikTokOverview,
  TikTokSyncResult,
} from '@orderloop/contracts';
import { Database, type Tx } from '@orderloop/db';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { CredentialVault } from '../couriers/credential-vault.js';
import { TIKTOK_METRICS, toLogFn } from './tiktok.providers.js';
import { TikTokRuntime } from './tiktok.runtime.js';

type ConnectionRow = NonNullable<Awaited<ReturnType<Tx['tikTokConnection']['findFirst']>>>;

/** The connection as the API returns it. Never carries a token, a cipher, or the grant: only whether the shop is usable. */
export function toTikTokConnection(row: ConnectionRow): TikTokConnection {
  return {
    id: row.id,
    shopId: row.shopId,
    shopName: row.shopName,
    region: row.region,
    sellerType: row.sellerType,
    currency: row.currency,
    status: row.status,
    mock: row.mock,
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    tokenExpiresAt: row.accessExpiresAt?.toISOString() ?? null,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    connectedAt: row.createdAt.toISOString(),
    disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
  };
}

/** Disconnected and without tokens: the one way a connection ends. Mirrored orders and reservations stay as they are. */
export async function markTikTokDisconnected(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<ConnectionRow> {
  return tx.tikTokConnection.update({
    where: { id, tenantId },
    data: {
      status: 'disconnected',
      accessTokenEnc: null,
      refreshTokenEnc: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
      nextRefreshAt: null,
      refreshFailures: 0,
      shopCipher: null,
      disconnectedAt: new Date(),
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
}

@Injectable()
export class TikTokConnectionsService {
  private readonly log = new Logger('TikTok');

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly runtime: TikTokRuntime,
    private readonly vault: CredentialVault,
    @Inject(TIKTOK_METRICS) private readonly metrics: TikTokMetrics,
  ) {}

  async overview(auth: AuthContext): Promise<TikTokOverview> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.tikTokConnection.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const live = this.runtime.mode === 'live';
      const [needsMapping, stockShort, attention, unmapped] = await Promise.all([
        tx.tikTokOrder.count({ where: { tenantId: auth.tenantId, stockState: 'needs_mapping' } }),
        tx.tikTokOrder.count({ where: { tenantId: auth.tenantId, stockState: 'stock_short' } }),
        tx.tikTokOrder.count({ where: { tenantId: auth.tenantId, attention: { not: null } } }),
        tx.tikTokSkuLink.count({ where: { tenantId: auth.tenantId, variantId: null } }),
      ]);
      return {
        mode: this.runtime.mode,
        liveConfigured: this.runtime.liveConfigured,
        webhookUrl: live ? this.runtime.webhookUrl : null,
        redirectUrl: live ? this.runtime.redirectUri : null,
        // A disconnected shop stays listed (with its status) so the screen can offer to connect it again.
        connections: rows.map(toTikTokConnection),
        needsMappingOrders: needsMapping,
        stockShortOrders: stockShort,
        attentionOrders: attention,
        unmappedSkus: unmapped,
      };
    });
  }

  // ---- mock mode ------------------------------------------------------------------------------------------------------

  requireMock(): void {
    // Not hidden behind a permission: in live mode (and in production, unless explicitly allowed) these simply do not exist.
    if (!this.runtime.mockEndpointsEnabled) throw ApiError.notFound();
  }

  async createMockConnection(
    auth: AuthContext,
    body: TikTokMockConnectionBody,
    ip: string | null,
  ): Promise<TikTokConnection> {
    this.requireMock();
    const suffix = randomBytes(5).toString('hex');
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const row = await tx.tikTokConnection.create({
        data: {
          tenantId: auth.tenantId,
          grantId: randomUUID(),
          // Cannot collide with a real TikTok shop id, nor with another business's mock shop.
          shopId: `mock_${suffix}`,
          shopName: body.shopName ?? 'Mock TikTok shop',
          region: body.region,
          sellerType: 'LOCAL',
          currency: body.currency,
          mock: true,
          scopes: [],
          connectedById: auth.userId,
        },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'integration.tiktok_connected',
        targetType: 'tiktok_connection',
        targetId: row.id,
        metadata: { mock: true },
        ip,
      });
      return toTikTokConnection(row);
    });
  }

  // ---- sync -------------------------------------------------------------------------------------------------------------

  /** Look at TikTok now (live) and at the orders waiting for a SKU link or stock (always). The scheduled check does the same. */
  async sync(auth: AuthContext, id: string): Promise<TikTokSyncResult> {
    const conn = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.tikTokConnection.findFirst({ where: { id, tenantId: auth.tenantId } }),
    );
    if (!conn) throw ApiError.notFound('Connection not found');
    if (conn.status === 'disconnected')
      throw ApiError.conflict('This shop is disconnected. Connect it again first.');
    const ref = { tenantId: auth.tenantId, connectionId: id };
    if (conn.mock) {
      const reconciled = await reconcileWaitingTikTokOrders(
        { db: this.db, sink: tiktokOrderSink, metrics: this.metrics },
        ref,
      );
      return { mode: this.runtime.mode, fetched: 0, updated: 0, reconciled, truncated: false };
    }
    const deps = {
      ...this.runtime.authDeps(this.db, this.vault, toLogFn(this.log), this.metrics),
      sink: tiktokOrderSink,
    };
    const r = await syncTikTokConnection(deps, ref);
    // A refusal found on the way was recorded on the connection: say so to the person who asked.
    const after = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.tikTokConnection.findFirst({
        where: { id, tenantId: auth.tenantId },
        select: { status: true },
      }),
    );
    if (after?.status === 'needs_reconnect')
      throw new ApiError(
        'tiktok_token_invalid',
        'TikTok no longer accepts the saved access. Reconnect this shop.',
      );
    if (after?.status === 'permission_error')
      throw new ApiError(
        'tiktok_permission_denied',
        'A permission this shop needs was removed or is missing. Reconnect and approve all permissions.',
      );
    return { mode: this.runtime.mode, ...r };
  }

  // ---- disconnect -------------------------------------------------------------------------------------------------------

  /** Stop receiving and forget the tokens. Repeating it changes nothing. Mirrored orders and stock already held stay as they are. */
  async disconnect(auth: AuthContext, id: string, ip: string | null): Promise<TikTokConnection> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const row = await tx.tikTokConnection.findFirst({ where: { id, tenantId: auth.tenantId } });
      if (!row) throw ApiError.notFound('Connection not found');
      if (row.status === 'disconnected') return toTikTokConnection(row);
      const updated = await markTikTokDisconnected(tx, auth.tenantId, id);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'integration.tiktok_disconnected',
        targetType: 'tiktok_connection',
        targetId: id,
        metadata: { mock: row.mock },
        ip,
      });
      return toTikTokConnection(updated);
    });
  }
}
