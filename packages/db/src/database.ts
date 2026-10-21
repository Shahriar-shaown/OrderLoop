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

export class Database {
  private readonly client: PrismaClient;

  constructor(connectionString: string, options: { max?: number } = {}) {
    this.client = new PrismaClient({
      adapter: new PrismaPg({ connectionString, max: options.max ?? 10 }),
    });
  }

  /** Run `fn` in one transaction with the RLS context applied. Commits on return, rolls back on throw. */
  withContext<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
    return this.client.$transaction(async (tx) => {
      // set_config(..., true) is transaction-local, so a pooled connection never carries it over.
      await applyContext(tx, ctx);
      return fn(tx);
    }, options);
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
