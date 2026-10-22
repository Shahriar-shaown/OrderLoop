import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/client.js';

export type Tx = Prisma.TransactionClient;
/** The only models reachable without a tenant context. Tenant tables are deliberately absent. */
export type GlobalDb = Pick<Tx, 'user' | 'session' | 'refreshToken' | 'userToken'>;

export interface DbContext {
  tenantId?: string | undefined;
  userId?: string | undefined;
}

export interface TxOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/** How many times in all a transaction that PostgreSQL aborted for a deadlock or a serialization failure is run. */
export const TX_ATTEMPTS = 3;

/**
 * Did PostgreSQL abort the transaction (and nothing else), so running it again is safe and likely to succeed? Deadlock
 * (40P01) and serialization failure (40001), however the driver and Prisma word them.
 */
export function isRetryableTxError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true; // "write conflict or a deadlock"
  return /\b(40P01|40001)\b|deadlock detected|could not serialize access/i.test(
    `${JSON.stringify(error.meta ?? {})} ${error.message}`,
  );
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Any canonical UUID, whatever its version. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(label: string, value: string | undefined): string {
  if (value === undefined) return '';
  if (!UUID_RE.test(value)) throw new TypeError(`${label} is not a UUID`);
  return value;
}

/**
 * The single entry point to PostgreSQL for api and worker.
 *
 * Tenant data is only reachable through {@link Database.withContext}, which opens a transaction and
 * sets the transaction-local settings that the row-level-security policies read. Outside a context
 * the runtime role sees zero tenant rows, so a query that forgets its context fails closed.
 */
/** Apply (or change) the RLS context inside a transaction that is already open. */
export async function applyContext(tx: Tx, ctx: DbContext): Promise<void> {
  const tenantId = assertUuid('tenantId', ctx.tenantId);
  const userId = assertUuid('userId', ctx.userId);
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true)`;
}

export interface EnabledRule {
  id: string;
  tenantId: string;
  kind:
    | 'LOW_STOCK'
    | 'NEW_ORDER'
    | 'UNCONFIRMED_ORDER'
    | 'DELAYED_ORDER'
    | 'COD_DISCREPANCY'
    | 'DAILY_REPORT'
    | 'WEEKLY_REPORT';
  config: Record<string, unknown>;
  timezone: string;
}

export interface PurgeResult {
  purged: boolean;
  rowsDeleted: number;
  /** Rows deleted per table (only tables that had rows). */
  counts: Record<string, number>;
  /** The person who asked was left with no business and their account was anonymised too. */
  userAnonymised: boolean;
}

export class Database {
  private readonly client: PrismaClient;

  constructor(connectionString: string, options: { max?: number } = {}) {
    this.client = new PrismaClient({
      adapter: new PrismaPg({ connectionString, max: options.max ?? 10 }),
    });
  }

  /**
   * Run `fn` in one transaction with the RLS context applied. Commits on return, rolls back on throw.
   * A transaction PostgreSQL aborts for a deadlock or serialization failure has changed nothing, so `fn` is run again
   * (up to {@link TX_ATTEMPTS} times, after a short random pause): `fn` must therefore do its work through `tx` only,
   * or be safe to repeat.
   */
  async withContext<T>(
    ctx: DbContext,
    fn: (tx: Tx) => Promise<T>,
    options: TxOptions = {},
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.client.$transaction(async (tx) => {
          // set_config(..., true) is transaction-local, so a pooled connection never carries it over.
          await applyContext(tx, ctx);
          return fn(tx);
        }, options);
      } catch (error) {
        if (attempt >= TX_ATTEMPTS || !isRetryableTxError(error)) throw error;
        await pause(10 * attempt + Math.random() * 40);
      }
    }
  }

  /** Global auth tables outside any tenant context (login lookup, refresh-token exchange). */
  get global(): GlobalDb {
    return this.client;
  }

  /** Delete idempotency keys older than `olderThanSeconds` (at least an hour), across tenants. For the worker's sweep. */
  async purgeIdempotencyKeys(olderThanSeconds: number): Promise<number> {
    const rows = await this.client.$queryRaw<
      { n: number }[]
    >`SELECT purge_idempotency_keys(${Math.ceil(olderThanSeconds)}::int) AS n`;
    return rows[0]?.n ?? 0;
  }

  /** The scheduler tick's one cross-business read: rules that are switched on, with their business's time zone, `afterId`-keyed pages in id order. */
  async enabledAutomationRules(afterId: string | null, maxRows = 500): Promise<EnabledRule[]> {
    if (afterId !== null) assertUuid('afterId', afterId);
    const rows = await this.client.$queryRaw<
      {
        id: string;
        tenant_id: string;
        kind: EnabledRule['kind'];
        config: unknown;
        timezone: string;
      }[]
    >`SELECT id, tenant_id, kind, config, timezone FROM enabled_automation_rules(${afterId}::uuid, ${Math.floor(maxRows)}::int)`;
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      kind: r.kind,
      config: (r.config ?? {}) as Record<string, unknown>,
      timezone: r.timezone,
    }));
  }

  /** Deliveries saved as pending that nothing has tried for `olderThanSeconds` (at least 30): the queue never got them. */
  async stalePendingDeliveries(
    olderThanSeconds: number,
    maxRows = 200,
  ): Promise<{ id: string; tenantId: string }[]> {
    const rows = await this.client.$queryRaw<
      { id: string; tenant_id: string }[]
    >`SELECT id, tenant_id FROM stale_pending_deliveries(${Math.ceil(olderThanSeconds)}::int, ${Math.floor(maxRows)}::int)`;
    return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
  }

  /** Forget a push token the push service reported dead, whoever it belonged to. */
  async removePushToken(token: string): Promise<number> {
    const rows = await this.client.$queryRaw<
      { n: number }[]
    >`SELECT remove_push_token(${token}) AS n`;
    return rows[0]?.n ?? 0;
  }

  /** The webhook's one cross-business read: the connected (not disconnected) account that owns a Page or Instagram id. */
  async metaConnectionFor(
    provider: 'facebook_page' | 'instagram',
    externalId: string,
  ): Promise<{
    id: string;
    tenantId: string;
    status: 'active' | 'needs_reconnect' | 'permission_error' | 'disconnected';
  } | null> {
    const rows = await this.client.$queryRaw<
      {
        id: string;
        tenant_id: string;
        status: 'active' | 'needs_reconnect' | 'permission_error' | 'disconnected';
      }[]
    >`SELECT id, tenant_id, status FROM meta_connection_for(${provider}::"SocialProvider", ${externalId})`;
    const r = rows[0];
    return r ? { id: r.id, tenantId: r.tenant_id, status: r.status } : null;
  }

  /** Webhook events saved as `received` that nothing has processed for `olderThanSeconds` (at least 30): the queue never got them. */
  async staleReceivedSocialEvents(
    olderThanSeconds: number,
    maxRows = 200,
  ): Promise<{ id: string; tenantId: string }[]> {
    const rows = await this.client.$queryRaw<
      { id: string; tenant_id: string }[]
    >`SELECT id, tenant_id FROM stale_received_social_events(${Math.ceil(olderThanSeconds)}::int, ${Math.floor(maxRows)}::int)`;
    return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
  }

  /** Connections that talk to the real Meta and can still work or recover, `afterId`-keyed pages in id order. For the health check. */
  async liveSocialConnections(
    afterId: string | null,
    maxRows = 200,
  ): Promise<{ id: string; tenantId: string }[]> {
    if (afterId !== null) assertUuid('afterId', afterId);
    const rows = await this.client.$queryRaw<
      { id: string; tenant_id: string }[]
    >`SELECT id, tenant_id FROM live_social_connections(${afterId}::uuid, ${Math.floor(maxRows)}::int)`;
    return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
  }

  /** Connections tied to a Meta id: the person who authorised them, or a customer who wrote to them. For the deauthorize and data-deletion callbacks. */
  async metaDeletionTargets(
    subject: string,
  ): Promise<{ tenantId: string; connectionId: string; reason: 'authoriser' | 'sender' }[]> {
    const rows = await this.client.$queryRaw<
      { tenant_id: string; connection_id: string; reason: 'authoriser' | 'sender' }[]
    >`SELECT tenant_id, connection_id, reason FROM meta_deletion_targets(${subject})`;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      connectionId: r.connection_id,
      reason: r.reason,
    }));
  }

  /** Retention for the Meta inbox across businesses (see the migration for exactly what goes). */
  async purgeSocialData(
    retentionDays: number,
  ): Promise<{ drafts: number; events: number; sessions: number }> {
    const rows = await this.client.$queryRaw<
      { drafts: number; events: number; sessions: number }[]
    >`SELECT drafts, events, sessions FROM purge_social_data(${Math.ceil(retentionDays)}::int)`;
    return rows[0] ?? { drafts: 0, events: 0, sessions: 0 };
  }

  /** Businesses whose deletion was requested and whose grace period is over (oldest first). The worker's purge reads this. */
  async tenantsDueForPurge(maxRows = 20): Promise<string[]> {
    const rows = await this.client.$queryRaw<
      { id: string }[]
    >`SELECT id FROM tenants_due_for_purge(${Math.floor(maxRows)}::int)`;
    return rows.map((r) => r.id);
  }

  /**
   * Delete a business and everything under it. Refused (`purged: false`, nothing changed) unless the business asked to be
   * deleted and its grace period is over, so repeating it, or racing another worker, is harmless. Row counts per table, no content.
   */
  async purgeTenant(tenantId: string): Promise<PurgeResult> {
    assertUuid('tenantId', tenantId);
    const rows = await this.client.$queryRaw<
      { purged: boolean; rows_deleted: number; counts: unknown; user_anonymised: boolean }[]
    >`SELECT purged, rows_deleted, counts, user_anonymised FROM purge_tenant(${tenantId}::uuid)`;
    const r = rows[0];
    return {
      purged: r?.purged ?? false,
      rowsDeleted: r?.rows_deleted ?? 0,
      counts: (r?.counts ?? {}) as Record<string, number>,
      userAnonymised: r?.user_anonymised ?? false,
    };
  }

  /** Liveness probe for readiness checks. */
  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  disconnect(): Promise<void> {
    return this.client.$disconnect();
  }
}

export function isUniqueViolation(error: unknown, field?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
    return false;
  if (!field) return true;
  // Depending on the driver the field shows up as meta.target, meta.constraint, or only in the message
  // (e.g. "users_email_key"), so search all of them.
  return `${JSON.stringify(error.meta ?? {})} ${error.message}`.includes(field);
}
