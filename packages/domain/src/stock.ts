/**
 * Stock ledger rules, as pure functions. The database enforces the same rules with CHECK constraints and conditional
 * UPDATEs (packages/catalog); this module is the executable specification both are tested against: replaying a ledger
 * with `replay` must always reproduce the stored stock level.
 *
 * Two quantities per variant and location:
 *   onHand   - physically on the shelf
 *   reserved - promised to open reservations
 * Available to sell = onHand - reserved. Invariants: 0 <= reserved <= onHand <= MAX_ON_HAND.
 */
export const MAX_ON_HAND = 1_000_000_000;

export interface StockLevel {
  onHand: number;
  reserved: number;
}

export type MovementType = 'RECEIVE' | 'ADJUSTMENT' | 'RESERVE' | 'RELEASE' | 'SHIP';

export interface Movement {
  type: MovementType;
  onHandDelta: number;
  reservedDelta: number;
}

export class StockInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockInvariantError';
  }
}

export const available = (level: StockLevel): number => level.onHand - level.reserved;

/** The allowed shape of each movement type. Mirrors the `stock_movements_shape` CHECK constraint in the database. */
export function hasValidShape(m: Movement): boolean {
  if (!Number.isSafeInteger(m.onHandDelta) || !Number.isSafeInteger(m.reservedDelta)) return false;
  switch (m.type) {
    case 'RECEIVE':
      return m.onHandDelta > 0 && m.reservedDelta === 0;
    case 'ADJUSTMENT':
      return m.onHandDelta !== 0 && m.reservedDelta === 0;
    case 'RESERVE':
      return m.onHandDelta === 0 && m.reservedDelta > 0;
    case 'RELEASE':
      return m.onHandDelta === 0 && m.reservedDelta < 0;
    case 'SHIP':
      return m.onHandDelta < 0 && m.reservedDelta === m.onHandDelta;
  }
}

export function isValidLevel(level: StockLevel): boolean {
  return (
    Number.isSafeInteger(level.onHand) &&
    Number.isSafeInteger(level.reserved) &&
    level.reserved >= 0 &&
    level.reserved <= level.onHand &&
    level.onHand <= MAX_ON_HAND
  );
}

/** Apply one movement. Throws if the movement is malformed or would break an invariant (for example overselling). */
export function applyMovement(level: StockLevel, m: Movement): StockLevel {
  if (!hasValidShape(m)) throw new StockInvariantError(`Malformed ${m.type} movement`);
  const next = { onHand: level.onHand + m.onHandDelta, reserved: level.reserved + m.reservedDelta };
  if (!isValidLevel(next)) {
    throw new StockInvariantError(
      `${m.type} would leave onHand=${next.onHand}, reserved=${next.reserved}`,
    );
  }
  return next;
}

/** Reproduce a stock level from its ledger. */
export function replay(
  movements: readonly Movement[],
  start: StockLevel = { onHand: 0, reserved: 0 },
): StockLevel {
  return movements.reduce(applyMovement, start);
}

/** Movement constructors, so callers cannot get the signs wrong. */
export const movement = {
  receive: (quantity: number): Movement => ({
    type: 'RECEIVE',
    onHandDelta: quantity,
    reservedDelta: 0,
  }),
  adjust: (delta: number): Movement => ({
    type: 'ADJUSTMENT',
    onHandDelta: delta,
    reservedDelta: 0,
  }),
  reserve: (quantity: number): Movement => ({
    type: 'RESERVE',
    onHandDelta: 0,
    reservedDelta: quantity,
  }),
  release: (quantity: number): Movement => ({
    type: 'RELEASE',
    onHandDelta: 0,
    reservedDelta: -quantity,
  }),
  ship: (quantity: number): Movement => ({
    type: 'SHIP',
    onHandDelta: -quantity,
    reservedDelta: -quantity,
  }),
};
