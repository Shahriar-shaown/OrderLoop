import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyMovement,
  available,
  hasValidShape,
  isValidLevel,
  MAX_ON_HAND,
  movement,
  replay,
  StockInvariantError,
  type Movement,
  type StockLevel,
} from './stock.js';

describe('movement shapes', () => {
  it('accepts exactly the documented shape of each type', () => {
    expect(hasValidShape(movement.receive(5))).toBe(true);
    expect(hasValidShape(movement.adjust(-3))).toBe(true);
    expect(hasValidShape(movement.reserve(2))).toBe(true);
    expect(hasValidShape(movement.release(2))).toBe(true);
    expect(hasValidShape(movement.ship(2))).toBe(true);
  });
  it('rejects zero, wrong-sign and mixed movements', () => {
    const bad: Movement[] = [
      { type: 'RECEIVE', onHandDelta: 0, reservedDelta: 0 },
      { type: 'RECEIVE', onHandDelta: -1, reservedDelta: 0 },
      { type: 'RECEIVE', onHandDelta: 1, reservedDelta: 1 },
      { type: 'ADJUSTMENT', onHandDelta: 0, reservedDelta: 0 },
      { type: 'RESERVE', onHandDelta: 1, reservedDelta: 1 },
      { type: 'RELEASE', onHandDelta: 0, reservedDelta: 1 },
      { type: 'SHIP', onHandDelta: -2, reservedDelta: -1 },
      { type: 'SHIP', onHandDelta: 1, reservedDelta: 1 },
      { type: 'RECEIVE', onHandDelta: 1.5, reservedDelta: 0 },
    ];
    for (const m of bad) expect(hasValidShape(m), JSON.stringify(m)).toBe(false);
  });
});

describe('applyMovement', () => {
  it('walks a realistic lifecycle', () => {
    let level: StockLevel = { onHand: 0, reserved: 0, damaged: 0 };
    level = applyMovement(level, movement.receive(10));
    level = applyMovement(level, movement.reserve(4));
    expect(available(level)).toBe(6);
    level = applyMovement(level, movement.ship(3)); // 3 of the 4 reserved units leave
    expect(level).toEqual({ onHand: 7, reserved: 1, damaged: 0 });
    level = applyMovement(level, movement.release(1));
    expect(level).toEqual({ onHand: 7, reserved: 0, damaged: 0 });
  });
  it('refuses overselling, going negative, and unreserved shipping', () => {
    const level = { onHand: 5, reserved: 2, damaged: 0 };
    expect(() => applyMovement(level, movement.reserve(4))).toThrow(StockInvariantError); // only 3 available
    expect(() => applyMovement(level, movement.adjust(-4))).toThrow(StockInvariantError); // would drop below reserved
    expect(() => applyMovement(level, movement.release(3))).toThrow(StockInvariantError);
    expect(() => applyMovement(level, movement.ship(3))).toThrow(StockInvariantError);
    expect(() =>
      applyMovement({ onHand: MAX_ON_HAND, reserved: 0, damaged: 0 }, movement.receive(1)),
    ).toThrow(StockInvariantError);
  });
});

/** A random operation; whether it is legal depends on the level it meets. */
const operation = fc.oneof(
  fc.integer({ min: 1, max: 50 }).map(movement.receive),
  fc
    .integer({ min: -50, max: 50 })
    .filter((n) => n !== 0)
    .map(movement.adjust),
  fc.integer({ min: 1, max: 50 }).map(movement.reserve),
  fc.integer({ min: 1, max: 50 }).map(movement.release),
  fc.integer({ min: 1, max: 50 }).map(movement.ship),
  fc.integer({ min: 1, max: 50 }).map(movement.damage),
  fc.integer({ min: 1, max: 50 }).map(movement.writeOff),
  fc.integer({ min: 1, max: 50 }).map(movement.returnResaleable),
  fc.integer({ min: 1, max: 50 }).map(movement.returnDamaged),
);

describe('damaged stock', () => {
  it('moves units out of what can be sold, and only available units', () => {
    let level: StockLevel = { onHand: 10, reserved: 4, damaged: 0 };
    level = applyMovement(level, movement.damage(6)); // exactly the available units
    expect(level).toEqual({ onHand: 4, reserved: 4, damaged: 6 });
    expect(available(level)).toBe(0);
    expect(() => applyMovement(level, movement.damage(1))).toThrow(StockInvariantError); // would cut into reserved
    level = applyMovement(level, movement.writeOff(6));
    expect(level.damaged).toBe(0);
    expect(() => applyMovement(level, movement.writeOff(1))).toThrow(StockInvariantError);
  });
  it('takes returns back as sellable or damaged', () => {
    let level: StockLevel = { onHand: 0, reserved: 0, damaged: 0 };
    level = applyMovement(level, movement.returnResaleable(2));
    level = applyMovement(level, movement.returnDamaged(1));
    expect(level).toEqual({ onHand: 2, reserved: 0, damaged: 1 });
  });
  it('rejects ledger rows with an impossible shape', () => {
    const bad = [
      { type: 'DAMAGE', onHandDelta: -3, reservedDelta: 0, damagedDelta: 2 }, // not balanced
      { type: 'DAMAGE', onHandDelta: 3, reservedDelta: 0, damagedDelta: -3 },
      { type: 'WRITE_OFF', onHandDelta: -1, reservedDelta: 0, damagedDelta: -1 },
      { type: 'RETURN', onHandDelta: 1, reservedDelta: 0, damagedDelta: 1 }, // both at once
      { type: 'RECEIVE', onHandDelta: 1, reservedDelta: 0, damagedDelta: 1 },
    ] as const;
    for (const m of bad) expect(hasValidShape(m), JSON.stringify(m)).toBe(false);
  });
});

describe('property: the ledger always reproduces the stock level', () => {
  it('applying any sequence of operations (skipping the illegal ones) keeps every invariant, and replaying the accepted ledger gives the same level', () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 200 }), (ops) => {
        let level: StockLevel = { onHand: 0, reserved: 0, damaged: 0 };
        const ledger: Movement[] = [];
        for (const op of ops) {
          try {
            level = applyMovement(level, op);
            ledger.push(op);
          } catch (error) {
            expect(error).toBeInstanceOf(StockInvariantError); // rejected, never partially applied
          }
          expect(isValidLevel(level)).toBe(true);
          expect(available(level)).toBeGreaterThanOrEqual(0);
        }
        expect(replay(ledger)).toEqual(level);
      }),
      { numRuns: 300 },
    );
  });

  it('available stock is never oversold: total reserved never exceeds total received minus shipped and removed', () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 200 }), (ops) => {
        let level: StockLevel = { onHand: 0, reserved: 0, damaged: 0 };
        for (const op of ops) {
          try {
            level = applyMovement(level, op);
          } catch {
            /* illegal for this state: refused */
          }
        }
        expect(level.reserved).toBeLessThanOrEqual(level.onHand);
        expect(level.damaged).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });
});
