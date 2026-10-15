import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/client.js';

export type Tx = Prisma.TransactionClient;
/** The only models reachable without a tenant context. Tenant tables are deliberately absent. */
export type GlobalDb = Pick<Tx, 'user' | 'session' | 'refreshToken'>;

export interface DbContext {
  tenantId?: string | undefined;
  userId?: string | undefined;
}

export interface TxOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
