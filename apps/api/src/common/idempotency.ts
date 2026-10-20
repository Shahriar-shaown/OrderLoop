import { createHash } from 'node:crypto';
import type { Database, Tx } from '@orderloop/db';
import { Prisma } from '@orderloop/db';
import { ApiError } from './api-error.js';
import { stable } from './stable.js';

export interface IdempotentCall {
  /** What the key is for, e.g. `POST /v1/products`. Include the parent id for nested creates. */
  scope: string;
  /** The caller's `idempotencyKey`. Without one this is a plain transaction: nothing is stored or looked up. */
  key: string | undefined;
  /** The request body (the key itself is ignored, so a retry hashes the same). */
  body: object;
  /** For creates that happen before a tenant exists: the key belongs to the user, not to the tenant. */
  userScoped?: boolean;
}

/**
 * Run `fn` in one transaction (with the usual row-level-security context) so that doing the same call twice with the same
 * key creates things once. The first call stores its result next to its own writes: a failed create leaves no key, a
 * committed one always has it. A repeat with the same body returns that result as it was; with a different body it is 409
 * `idempotency_conflict`. Two identical calls at once are serialised on the key, so the second waits and then replays.
 */
export async function idempotent<T>(
  db: Database,
  ctx: { tenantId?: string; userId: string },
  call: IdempotentCall,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const key = call.key;
  if (!key) return db.withContext(ctx, fn);

  const owner = call.userScoped
    ? { tenantId: null, userId: ctx.userId }
    : { tenantId: ctx.tenantId!, userId: null };
  // The key itself is not part of what is compared (`stable` leaves out undefined).
  const requestHash = createHash('sha256')
    .update(stable({ ...call.body, idempotencyKey: undefined }))
    .digest('hex');

  return db.withContext(ctx, async (tx) => {
    // One lock per (owner, scope, key), released at commit or rollback.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${owner.tenantId ?? owner.userId}|${call.scope}|${key}`}, 0))`;
    const stored = await tx.idempotencyKey.findFirst({
      where: { ...owner, scope: call.scope, key },
      select: { requestHash: true, responseBody: true },
    });
    if (stored) {
      if (stored.requestHash !== requestHash)
        throw new ApiError(
          'idempotency_conflict',
          'This idempotency key was already used for a different request',
        );
      return stored.responseBody as T;
    }
    const result = await fn(tx);
    await tx.idempotencyKey.create({
      data: {
        ...owner,
        scope: call.scope,
        key,
        requestHash,
        responseBody: result as Prisma.InputJsonValue,
      },
    });
    return result;
  });
}
