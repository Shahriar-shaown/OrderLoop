import { StockMovementType, type Tx } from '@orderloop/db';

/**
 * The only code that changes stock. Every change is one conditional SQL UPDATE of stock_levels plus one appended
 * stock_movements row, in the caller's transaction, so the stored level and the ledger cannot drift apart.
 *
 * Overselling is prevented by the UPDATE itself, not by reading and then writing: `... WHERE on_hand - reserved >= q`
 * is evaluated atomically under the row lock, so of N concurrent reservations competing for the last units, exactly as
 * many succeed as there is stock. CHECK constraints in the database are a second barrier behind this one.
 */
export class InsufficientStockError extends Error {
  constructor(
    readonly available: number,
    readonly requested: number,
  ) {
    super(`Only ${available} available, ${requested} requested`);
    this.name = 'InsufficientStockError';
  }
}

/** A request named a variant or location that does not exist (or is archived) in this tenant. */
export class StockTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockTargetError';
  }
}

/** The stock level would exceed the database's maximum (a CHECK constraint). */
export class StockLimitError extends Error {
  constructor() {
    super('The on-hand quantity would exceed the maximum of 1,000,000,000');
    this.name = 'StockLimitError';
  }
}

export interface StockTarget {
  tenantId: string;
  variantId: string;
  locationId: string;
}

export interface MovementMeta {
  createdById?: string | null | undefined;
  reason?: string | null | undefined;
  referenceType?: string | null | undefined;
  referenceId?: string | null | undefined;
  /** A retry with the same key violates a unique index; callers catch that and return the first result. */
  idempotencyKey?: string | null | undefined;
}

export interface Level {
  onHand: number;
  reserved: number;
  available: number;
}

export interface StockResult {
  movementId: string;
  level: Level;
}

const toLevel = (row: { onHand: number; reserved: number } | null): Level => {
  const onHand = row?.onHand ?? 0;
  const reserved = row?.reserved ?? 0;
  return { onHand, reserved, available: onHand - reserved };
};

export async function readLevel(tx: Tx, t: StockTarget): Promise<Level> {
  const row = await tx.stockLevel.findUnique({
    where: {
      tenantId_variantId_locationId: {
        tenantId: t.tenantId,
        variantId: t.variantId,
        locationId: t.locationId,
      },
    },
    select: { onHand: true, reserved: true },
  });
  return toLevel(row);
}

async function appendMovement(
  tx: Tx,
  t: StockTarget,
  type: StockMovementType,
  onHandDelta: number,
  reservedDelta: number,
  meta: MovementMeta,
  reservationId?: string,
): Promise<string> {
  const movement = await tx.stockMovement.create({
    data: {
      tenantId: t.tenantId,
      variantId: t.variantId,
      locationId: t.locationId,
      type,
      onHandDelta,
      reservedDelta,
      reason: meta.reason ?? null,
      referenceType: meta.referenceType ?? null,
      referenceId: meta.referenceId ?? null,
      reservationId: reservationId ?? null,
      idempotencyKey: meta.idempotencyKey ?? null,
      createdById: meta.createdById ?? null,
    },
    select: { id: true },
  });
  return movement.id;
}

/** Add to on_hand, creating the level row on first use. */
async function addOnHand(tx: Tx, t: StockTarget, quantity: number): Promise<void> {
  try {
    await tx.$executeRaw`
      INSERT INTO stock_levels (tenant_id, variant_id, location_id, on_hand, reserved, updated_at)
      VALUES (${t.tenantId}::uuid, ${t.variantId}::uuid, ${t.locationId}::uuid, ${quantity}::int, 0, now())
      ON CONFLICT (tenant_id, variant_id, location_id)
      DO UPDATE SET on_hand = stock_levels.on_hand + EXCLUDED.on_hand, updated_at = now()`;
  } catch (error) {
    if (String((error as Error).message).includes('stock_levels_on_hand_max'))
      throw new StockLimitError();
    throw error;
  }
}

export async function receiveStock(
  tx: Tx,
  t: StockTarget,
  quantity: number,
  meta: MovementMeta = {},
): Promise<StockResult> {
  await addOnHand(tx, t, quantity);
  const movementId = await appendMovement(tx, t, StockMovementType.RECEIVE, quantity, 0, meta);
  return { movementId, level: await readLevel(tx, t) };
}

/** A signed correction to on_hand. A decrease may never cut into reserved stock. */
export async function adjustStock(
  tx: Tx,
  t: StockTarget,
  delta: number,
  meta: MovementMeta = {},
): Promise<StockResult> {
  if (delta > 0) {
    await addOnHand(tx, t, delta);
  } else {
    const changed = await tx.$executeRaw`
      UPDATE stock_levels SET on_hand = on_hand + ${delta}::int, updated_at = now()
      WHERE tenant_id = ${t.tenantId}::uuid AND variant_id = ${t.variantId}::uuid AND location_id = ${t.locationId}::uuid
        AND on_hand + ${delta}::int >= reserved`;
    if (changed === 0) {
      const level = await readLevel(tx, t);
      throw new InsufficientStockError(level.available, -delta);
    }
  }
  const movementId = await appendMovement(tx, t, StockMovementType.ADJUSTMENT, delta, 0, meta);
  return { movementId, level: await readLevel(tx, t) };
}

export interface ReserveResult extends StockResult {
  reservationId: string;
}

/** Hold stock. Fails with InsufficientStockError when fewer than `quantity` are available. */
export async function reserveStock(
  tx: Tx,
  t: StockTarget,
  quantity: number,
  meta: MovementMeta = {},
): Promise<ReserveResult> {
  const changed = await tx.$executeRaw`
    UPDATE stock_levels SET reserved = reserved + ${quantity}::int, updated_at = now()
    WHERE tenant_id = ${t.tenantId}::uuid AND variant_id = ${t.variantId}::uuid AND location_id = ${t.locationId}::uuid
      AND on_hand - reserved >= ${quantity}::int`;
  if (changed === 0) {
    const level = await readLevel(tx, t);
    throw new InsufficientStockError(level.available, quantity);
  }
  const reservation = await tx.reservation.create({
    data: {
      tenantId: t.tenantId,
      variantId: t.variantId,
      locationId: t.locationId,
      quantity,
      referenceType: meta.referenceType ?? null,
      referenceId: meta.referenceId ?? null,
      createdById: meta.createdById ?? null,
    },
    select: { id: true },
  });
  const movementId = await appendMovement(
    tx,
    t,
    StockMovementType.RESERVE,
    0,
    quantity,
    meta,
    reservation.id,
  );
  return { reservationId: reservation.id, movementId, level: await readLevel(tx, t) };
}

export type ReservationOutcome = 'RELEASED' | 'FULFILLED';

/**
 * Resolve an ACTIVE reservation exactly once. The status flip is a compare-and-set, so two concurrent callers cannot
 * both release (or both ship) the same units. Returns null when the reservation is not active (already resolved, or
 * not found), leaving the caller to say which.
 */
export async function resolveReservation(
  tx: Tx,
  tenantId: string,
  reservationId: string,
  outcome: ReservationOutcome,
  meta: MovementMeta = {},
): Promise<(StockResult & { target: StockTarget; quantity: number }) | null> {
  const reservation = await tx.reservation.findFirst({
    where: { id: reservationId, tenantId, status: 'ACTIVE' },
  });
  if (!reservation) return null;
  const claimed = await tx.reservation.updateMany({
    where: { id: reservationId, tenantId, status: 'ACTIVE' },
    data: { status: outcome, resolvedAt: new Date() },
  });
  if (claimed.count !== 1) return null;

  const target: StockTarget = {
    tenantId,
    variantId: reservation.variantId,
    locationId: reservation.locationId,
  };
  const q = reservation.quantity;
  const changed =
    outcome === 'RELEASED'
      ? await tx.$executeRaw`
          UPDATE stock_levels SET reserved = reserved - ${q}::int, updated_at = now()
          WHERE tenant_id = ${tenantId}::uuid AND variant_id = ${target.variantId}::uuid AND location_id = ${target.locationId}::uuid AND reserved >= ${q}::int`
      : await tx.$executeRaw`
          UPDATE stock_levels SET on_hand = on_hand - ${q}::int, reserved = reserved - ${q}::int, updated_at = now()
          WHERE tenant_id = ${tenantId}::uuid AND variant_id = ${target.variantId}::uuid AND location_id = ${target.locationId}::uuid AND reserved >= ${q}::int`;
  // An active reservation always has its units counted in `reserved`; anything else means the books are corrupt.
  if (changed !== 1)
    throw new Error(`Stock invariant violated resolving reservation ${reservationId}`);

  const movementId =
    outcome === 'RELEASED'
      ? await appendMovement(tx, target, StockMovementType.RELEASE, 0, -q, meta, reservationId)
      : await appendMovement(tx, target, StockMovementType.SHIP, -q, -q, meta, reservationId);
  return { movementId, level: await readLevel(tx, target), target, quantity: q };
}

/**
 * The tenant's default stock location. Resolution order: the existing default; otherwise the oldest active location
 * is promoted (so a location someone created first is never shadowed by a second one we invent); otherwise "Main
 * warehouse" is created. An advisory lock per tenant makes concurrent first uses queue up instead of racing on the
 * unique indexes.
 */
export async function ensureDefaultLocation(tx: Tx, tenantId: string): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'default-location:' + tenantId}, 0))`;
  const existing = await tx.stockLocation.findFirst({
    where: { tenantId, isDefault: true, archivedAt: null },
    select: { id: true },
  });
  if (existing) return existing.id;

  const oldest = await tx.stockLocation.findFirst({
    where: { tenantId, archivedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  if (oldest) {
    await tx.stockLocation.updateMany({
      where: { tenantId, isDefault: true },
      data: { isDefault: false },
    }); // an archived former default
    await tx.stockLocation.update({ where: { id: oldest.id }, data: { isDefault: true } });
    return oldest.id;
  }
  const created = await tx.stockLocation.create({
    data: { tenantId, name: 'Main warehouse', nameKey: 'main warehouse', isDefault: true },
    select: { id: true },
  });
  return created.id;
}

/**
 * The location a request refers to: the one named (which must be active), or the default. The named location row is
 * locked FOR SHARE until the transaction ends, so archiving it (which takes the lock exclusively) cannot slip in between
 * this check and the stock change that follows.
 */
export async function resolveLocation(
  tx: Tx,
  tenantId: string,
  locationId?: string | null,
): Promise<string> {
  if (!locationId) {
    const id = await ensureDefaultLocation(tx, tenantId);
    await tx.$queryRaw`SELECT id FROM stock_locations WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR SHARE`;
    return id;
  }
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM stock_locations WHERE tenant_id = ${tenantId}::uuid AND id = ${locationId}::uuid AND archived_at IS NULL FOR SHARE`;
  if (!rows[0]) throw new StockTargetError('Stock location not found');
  return rows[0].id;
}
