import { Injectable } from '@nestjs/common';
import type {
  InventorySummary,
  AdjustBody,
  DamageBody,
  ReturnBody,
  WriteOffBody,
  InventoryPage,
  InventoryQuery,
  LowStockItem,
  MovementPage,
  MovementQuery,
  ReceiveBody,
  StockChange,
} from '@orderloop/contracts';
import {
  adjustStock,
  markDamaged,
  receiveStock,
  resolveLocation,
  returnStock,
  writeOffDamaged,
  type Level,
} from '@orderloop/catalog';
import { Database, isUniqueViolation, Prisma, type Tx } from '@orderloop/db';
import { ApiError } from '../common/api-error.js';
import {
  decodePairCursor,
  decodeSeqCursor,
  encodePairCursor,
  encodeSeqCursor,
} from '../common/cursor.js';
import type { AuthContext } from '../common/endpoint.js';
import { mapStockError } from '../common/stock-errors.js';

type Expected = {
  variantId: string;
  locationId?: string | undefined;
  type: 'RECEIVE' | 'ADJUSTMENT' | 'RESERVE' | 'DAMAGE' | 'WRITE_OFF' | 'RETURN';
  onHandDelta?: number;
  reservedDelta?: number;
  damagedDelta?: number;
};
type PriorMovement = {
  id: string;
  variantId: string;
  locationId: string;
  type: string;
  onHandDelta: number;
  reservedDelta: number;
  damagedDelta: number;
  reservationId: string | null;
};

const change = (
  movementId: string,
  variantId: string,
  locationId: string,
  level: Level,
): StockChange => ({
  movementId,
  variantId,
  locationId,
  onHand: level.onHand,
  reserved: level.reserved,
  available: level.available,
  damaged: level.damaged,
});

/** Shared by inventory and reservations: run a stock mutation at most once per idempotency key. */
@Injectable()
export class StockRunner {
  constructor(private readonly db: Database) {}

  async requireActiveVariant(tx: Tx, tenantId: string, variantId: string): Promise<void> {
    // FOR SHARE: archiving the variant (which takes the lock exclusively) waits for this transaction, so a stock change
    // cannot commit against a variant that was archived a moment earlier.
    const rows = await tx.$queryRaw<{ archived_at: Date | null; product_status: string }[]>`
      SELECT v.archived_at, p.status AS product_status
      FROM product_variants v JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.id = ${variantId}::uuid
      FOR SHARE OF v`;
    const v = rows[0];
    if (!v) throw ApiError.notFound('Variant not found');
    if (v.archived_at) throw ApiError.conflict('This variant is archived');
    if (v.product_status === 'ARCHIVED') throw ApiError.conflict('This product is archived');
  }

  /**
   * `work` does the change; `replay` rebuilds the original answer when the key was already used. A key reused for a
   * different request is a client bug and is refused rather than silently ignored. Two simultaneous requests with one
   * key race on a unique index: the loser rolls back entirely, then finds the winner's row and replays it.
   */
  async run<T>(
    auth: AuthContext,
    key: string | undefined,
    expected: Expected,
    work: (tx: Tx) => Promise<T>,
    replay: (tx: Tx, prior: PriorMovement) => Promise<T>,
  ): Promise<T> {
    const attempt = () =>
      this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
        if (key) {
          const prior = await tx.stockMovement.findUnique({
            where: { tenantId_idempotencyKey: { tenantId: auth.tenantId, idempotencyKey: key } },
          });
          if (prior) {
            const same =
              prior.variantId === expected.variantId &&
              prior.type === expected.type &&
              (expected.locationId === undefined || prior.locationId === expected.locationId) &&
              (expected.onHandDelta === undefined || prior.onHandDelta === expected.onHandDelta) &&
              (expected.reservedDelta === undefined ||
                prior.reservedDelta === expected.reservedDelta) &&
              (expected.damagedDelta === undefined || prior.damagedDelta === expected.damagedDelta);
            if (!same)
              throw ApiError.conflict(
                'This idempotency key was already used for a different request',
              );
            return replay(tx, prior);
          }
        }
        return work(tx);
      });
    try {
      return await attempt();
    } catch (error) {
      if (key && isUniqueViolation(error, 'idempotency_key')) return attempt();
      return mapStockError(error);
    }
  }
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly db: Database,
    private readonly runner: StockRunner,
  ) {}

  receive(auth: AuthContext, body: ReceiveBody): Promise<StockChange> {
    return this.runner.run(
      auth,
      body.idempotencyKey,
      {
        variantId: body.variantId,
        locationId: body.locationId,
        type: 'RECEIVE',
        onHandDelta: body.quantity,
      },
      async (tx) => {
        await this.runner.requireActiveVariant(tx, auth.tenantId, body.variantId);
        const locationId = await resolveLocation(tx, auth.tenantId, body.locationId);
        const r = await receiveStock(
          tx,
          { tenantId: auth.tenantId, variantId: body.variantId, locationId },
          body.quantity,
          {
            createdById: auth.userId,
            reason: body.reason,
            referenceType: body.referenceType,
            referenceId: body.referenceId,
            idempotencyKey: body.idempotencyKey,
          },
        );
        return change(r.movementId, body.variantId, locationId, r.level);
      },
      (tx, prior) => this.replayChange(tx, auth.tenantId, prior),
    );
  }

  adjust(auth: AuthContext, body: AdjustBody): Promise<StockChange> {
    return this.runner.run(
      auth,
      body.idempotencyKey,
      {
        variantId: body.variantId,
        locationId: body.locationId,
        type: 'ADJUSTMENT',
        onHandDelta: body.delta,
      },
      async (tx) => {
        await this.runner.requireActiveVariant(tx, auth.tenantId, body.variantId);
        const locationId = await resolveLocation(tx, auth.tenantId, body.locationId);
        const r = await adjustStock(
          tx,
          { tenantId: auth.tenantId, variantId: body.variantId, locationId },
          body.delta,
          {
            createdById: auth.userId,
            reason: body.reason,
            idempotencyKey: body.idempotencyKey,
          },
        );
        return change(r.movementId, body.variantId, locationId, r.level);
      },
      (tx, prior) => this.replayChange(tx, auth.tenantId, prior),
    );
  }

  damage(auth: AuthContext, body: DamageBody): Promise<StockChange> {
    return this.runner.run(
      auth,
      body.idempotencyKey,
      {
        variantId: body.variantId,
        locationId: body.locationId,
        type: 'DAMAGE',
        onHandDelta: -body.quantity,
        damagedDelta: body.quantity,
      },
      async (tx) => {
        await this.runner.requireActiveVariant(tx, auth.tenantId, body.variantId);
        const locationId = await resolveLocation(tx, auth.tenantId, body.locationId);
        const r = await markDamaged(
          tx,
          { tenantId: auth.tenantId, variantId: body.variantId, locationId },
          body.quantity,
          { createdById: auth.userId, reason: body.reason, idempotencyKey: body.idempotencyKey },
        );
        return change(r.movementId, body.variantId, locationId, r.level);
      },
      (tx, prior) => this.replayChange(tx, auth.tenantId, prior),
    );
  }

  writeOff(auth: AuthContext, body: WriteOffBody): Promise<StockChange> {
    return this.runner.run(
      auth,
      body.idempotencyKey,
      {
        variantId: body.variantId,
        locationId: body.locationId,
        type: 'WRITE_OFF',
        damagedDelta: -body.quantity,
      },
      async (tx) => {
        await this.runner.requireActiveVariant(tx, auth.tenantId, body.variantId);
        const locationId = await resolveLocation(tx, auth.tenantId, body.locationId);
        const r = await writeOffDamaged(
          tx,
          { tenantId: auth.tenantId, variantId: body.variantId, locationId },
          body.quantity,
          { createdById: auth.userId, reason: body.reason, idempotencyKey: body.idempotencyKey },
        );
        return change(r.movementId, body.variantId, locationId, r.level);
      },
      (tx, prior) => this.replayChange(tx, auth.tenantId, prior),
    );
  }

  returnStock(auth: AuthContext, body: ReturnBody): Promise<StockChange> {
    const resaleable = body.condition === 'RESALEABLE';
    return this.runner.run(
      auth,
      body.idempotencyKey,
      {
        variantId: body.variantId,
        locationId: body.locationId,
        type: 'RETURN',
        onHandDelta: resaleable ? body.quantity : 0,
        damagedDelta: resaleable ? 0 : body.quantity,
      },
      async (tx) => {
        await this.runner.requireActiveVariant(tx, auth.tenantId, body.variantId);
        const locationId = await resolveLocation(tx, auth.tenantId, body.locationId);
        const r = await returnStock(
          tx,
          { tenantId: auth.tenantId, variantId: body.variantId, locationId },
          body.quantity,
          body.condition,
          {
            createdById: auth.userId,
            reason: body.reason,
            referenceType: body.referenceType,
            referenceId: body.referenceId,
            idempotencyKey: body.idempotencyKey,
          },
        );
        return change(r.movementId, body.variantId, locationId, r.level);
      },
      (tx, prior) => this.replayChange(tx, auth.tenantId, prior),
    );
  }

  private async replayChange(tx: Tx, tenantId: string, prior: PriorMovement): Promise<StockChange> {
    const level = await tx.stockLevel.findUnique({
      where: {
        tenantId_variantId_locationId: {
          tenantId,
          variantId: prior.variantId,
          locationId: prior.locationId,
        },
      },
    });
    const onHand = level?.onHand ?? 0;
    const reserved = level?.reserved ?? 0;
    return change(prior.id, prior.variantId, prior.locationId, {
      onHand,
      reserved,
      available: onHand - reserved,
      damaged: level?.damaged ?? 0,
    });
  }

  list(auth: AuthContext, query: InventoryQuery): Promise<InventoryPage> {
    const cursor = query.cursor ? decodePairCursor(query.cursor) : undefined;
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          variant_id: string;
          sku: string;
          product_name: string;
          variant_name: string;
          location_id: string;
          location_name: string;
          on_hand: number;
          reserved: number;
          damaged: number;
          reorder_point: number;
        }[]
      >(Prisma.sql`
        SELECT l.variant_id, v.sku, p.name AS product_name, v.name AS variant_name, l.location_id, loc.name AS location_name,
               l.on_hand, l.reserved, l.damaged, v.reorder_point
        FROM stock_levels l
        JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
        JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
        JOIN stock_locations loc ON loc.tenant_id = l.tenant_id AND loc.id = l.location_id
        WHERE l.tenant_id = ${auth.tenantId}::uuid
          ${query.variantId ? Prisma.sql`AND l.variant_id = ${query.variantId}::uuid` : Prisma.empty}
          ${query.locationId ? Prisma.sql`AND l.location_id = ${query.locationId}::uuid` : Prisma.empty}
          ${query.lowStock ? Prisma.sql`AND v.reorder_point > 0 AND (l.on_hand - l.reserved) <= v.reorder_point` : Prisma.empty}
          ${cursor ? Prisma.sql`AND (l.variant_id, l.location_id) > (${cursor.a}::uuid, ${cursor.b}::uuid)` : Prisma.empty}
        ORDER BY l.variant_id, l.location_id
        LIMIT ${query.limit + 1}`);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          variantId: r.variant_id,
          sku: r.sku,
          productName: r.product_name,
          variantName: r.variant_name,
          locationId: r.location_id,
          locationName: r.location_name,
          onHand: r.on_hand,
          reserved: r.reserved,
          available: r.on_hand - r.reserved,
          damaged: r.damaged,
          reorderPoint: r.reorder_point,
        })),
        nextCursor:
          rows.length > query.limit && last
            ? encodePairCursor(last.variant_id, last.location_id)
            : null,
      };
    });
  }

  movements(auth: AuthContext, query: MovementQuery): Promise<MovementPage> {
    const cursor = query.cursor ? decodeSeqCursor(query.cursor) : undefined;
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.stockMovement.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(query.variantId ? { variantId: query.variantId } : {}),
          ...(query.locationId ? { locationId: query.locationId } : {}),
          ...(query.type ? { type: query.type } : {}),
          ...(cursor !== undefined ? { seq: { lt: cursor } } : {}),
        },
        orderBy: { seq: 'desc' },
        take: query.limit + 1,
        include: { variant: { select: { sku: true } } },
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((m) => ({
          id: m.id,
          type: m.type,
          variantId: m.variantId,
          sku: m.variant.sku,
          locationId: m.locationId,
          onHandDelta: m.onHandDelta,
          reservedDelta: m.reservedDelta,
          damagedDelta: m.damagedDelta,
          reason: m.reason,
          referenceType: m.referenceType,
          referenceId: m.referenceId,
          reservationId: m.reservationId,
          createdById: m.createdById,
          createdAt: m.createdAt.toISOString(),
        })),
        nextCursor: rows.length > query.limit && last ? encodeSeqCursor(last.seq) : null,
      };
    });
  }

  /** Inventory value and stock counts, over active variants of active products. */
  summary(auth: AuthContext): Promise<InventorySummary> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const [r] = await tx.$queryRaw<
        {
          products: number;
          variants: number;
          cost: bigint;
          retail: bigint;
          missing: number;
          low: number;
          out: number;
        }[]
      >`
        WITH v AS (
          SELECT v.id, v.product_id, v.price_minor, v.cost_minor, v.reorder_point,
                 COALESCE(SUM(l.on_hand), 0)::bigint AS on_hand, COALESCE(SUM(l.reserved), 0)::bigint AS reserved
          FROM product_variants v
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          LEFT JOIN stock_levels l ON l.tenant_id = v.tenant_id AND l.variant_id = v.id
          WHERE v.tenant_id = ${auth.tenantId}::uuid AND v.archived_at IS NULL AND p.status = 'ACTIVE'
          GROUP BY v.id)
        SELECT count(DISTINCT product_id)::int AS products, count(*)::int AS variants,
               COALESCE(sum(on_hand * cost_minor) FILTER (WHERE cost_minor IS NOT NULL), 0) AS cost,
               COALESCE(sum(on_hand * price_minor), 0) AS retail,
               (count(*) FILTER (WHERE cost_minor IS NULL AND on_hand > 0))::int AS missing,
               (count(*) FILTER (WHERE reorder_point > 0 AND on_hand - reserved <= reorder_point))::int AS low,
               (count(*) FILTER (WHERE on_hand - reserved <= 0))::int AS out
        FROM v`;
      return {
        products: r?.products ?? 0,
        variants: r?.variants ?? 0,
        inventoryValueCostMinor: Number(r?.cost ?? 0),
        retailValueMinor: Number(r?.retail ?? 0),
        missingCostVariants: r?.missing ?? 0,
        lowStockCount: r?.low ?? 0,
        outOfStockCount: r?.out ?? 0,
      };
    });
  }

  lowStock(auth: AuthContext): Promise<LowStockItem[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          variant_id: string;
          sku: string;
          product_name: string;
          variant_name: string;
          reorder_point: number;
          on_hand: bigint;
          reserved: bigint;
          damaged: bigint;
        }[]
      >`
        SELECT v.id AS variant_id, v.sku, p.name AS product_name, v.name AS variant_name, v.reorder_point,
               COALESCE(SUM(l.on_hand), 0) AS on_hand, COALESCE(SUM(l.reserved), 0) AS reserved,
               COALESCE(SUM(l.damaged), 0) AS damaged
        FROM product_variants v
        JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
        LEFT JOIN stock_levels l ON l.tenant_id = v.tenant_id AND l.variant_id = v.id
        WHERE v.tenant_id = ${auth.tenantId}::uuid AND v.archived_at IS NULL AND p.status = 'ACTIVE' AND v.reorder_point > 0
        GROUP BY v.id, p.name
        HAVING COALESCE(SUM(l.on_hand), 0) - COALESCE(SUM(l.reserved), 0) <= v.reorder_point
        ORDER BY COALESCE(SUM(l.on_hand), 0) - COALESCE(SUM(l.reserved), 0), v.sku
        LIMIT 500`;
      return rows.map((r) => ({
        variantId: r.variant_id,
        sku: r.sku,
        productName: r.product_name,
        variantName: r.variant_name,
        reorderPoint: r.reorder_point,
        onHand: Number(r.on_hand),
        reserved: Number(r.reserved),
        available: Number(r.on_hand) - Number(r.reserved),
        damaged: Number(r.damaged),
      }));
    });
  }
}
