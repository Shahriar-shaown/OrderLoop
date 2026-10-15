import { Injectable } from '@nestjs/common';
import type { AuditPage, AuditQuery } from '@orderloop/contracts';
import { Database, type Prisma, type Tx } from '@orderloop/db';

export interface AuditEvent {
  tenantId: string | null;
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: Database) {}

  /**
   * Append an event inside the caller's transaction, so it commits or rolls back with the change.
   * `createMany` (no RETURNING) because null-tenant rows are insert-only under row-level security.
   */
  async record(tx: Tx, event: AuditEvent): Promise<void> {
    await tx.auditLog.createMany({
      data: [
        {
          tenantId: event.tenantId,
          actorUserId: event.actorUserId ?? null,
          action: event.action,
          targetType: event.targetType ?? null,
          targetId: event.targetId ?? null,
          ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
          ip: event.ip ?? null,
        },
      ],
    });
  }

  /** Append an event that has no tenant context (for example a failed login). */
  recordOutsideTenant(event: Omit<AuditEvent, 'tenantId'>): Promise<void> {
    return this.db.withContext({}, (tx) => this.record(tx, { ...event, tenantId: null }));
  }

  async list(tenantId: string, query: AuditQuery): Promise<AuditPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.db.withContext({ tenantId }, (tx) =>
      tx.auditLog.findMany({
        where: {
          tenantId,
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
      items: page.map((r) => ({
        id: r.id,
        action: r.action,
        actorUserId: r.actorUserId,
        targetType: r.targetType,
        targetId: r.targetId,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | undefined {
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t: string;
      id: string;
    };
    const createdAt = new Date(t);
    if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}
