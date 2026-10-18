import { OrderSource, OrderStatus as OrderStatusSchema, ORDER_SOURCES } from '@orderloop/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  calculateOrderTotals,
  canTransition,
  editScope,
  formatBdPhone,
  holdsStock,
  isFinalStatus,
  normalizeBdPhone,
  ORDER_LIMITS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  OrderTotalsError,
  REASON_REQUIRED,
  stockEffect,
  type OrderStatus,
} from './orders.js';

describe('order state machine', () => {
  it('lists exactly the agreed states', () => {
    expect([...ORDER_STATUSES]).toEqual([
      'pending_confirmation',
      'confirmed',
      'ready_to_ship',
      'shipped',
      'in_transit',
      'delivered',
      'delivery_failed',
      'cancelled',
      'return_requested',
      'returned',
    ]);
  });

  it('allows the normal path, in order', () => {
    const path: OrderStatus[] = [
      'pending_confirmation',
      'confirmed',
      'ready_to_ship',
      'shipped',
      'in_transit',
      'delivered',
    ];
    for (let i = 0; i < path.length - 1; i++)
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
  });

  it('refuses skipping steps and going backwards', () => {
    const illegal: [OrderStatus, OrderStatus][] = [
      ['pending_confirmation', 'ready_to_ship'],
      ['pending_confirmation', 'shipped'],
      ['confirmed', 'shipped'],
      ['confirmed', 'pending_confirmation'],
      ['ready_to_ship', 'confirmed'],
      ['shipped', 'ready_to_ship'],
      ['shipped', 'cancelled'], // the goods have left
      ['in_transit', 'cancelled'],
      ['delivered', 'cancelled'],
      ['delivered', 'in_transit'],
      ['returned', 'delivered'],
      ['cancelled', 'confirmed'],
      ['cancelled', 'pending_confirmation'],
    ];
    for (const [from, to] of illegal)
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
  });

  it('never allows a state to move to itself, and final states go nowhere', () => {
    for (const s of ORDER_STATUSES) expect(canTransition(s, s)).toBe(false);
    expect(isFinalStatus('cancelled')).toBe(true);
    expect(isFinalStatus('returned')).toBe(true);
    expect(isFinalStatus('delivered')).toBe(false); // can still become a return
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
  });

  it('every state is reachable from the start, and every transition target is a real state', () => {
    const seen = new Set<OrderStatus>(['pending_confirmation']);
    const queue: OrderStatus[] = ['pending_confirmation'];
    while (queue.length) {
      for (const next of ORDER_TRANSITIONS[queue.shift()!]) {
        expect(ORDER_STATUSES).toContain(next);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('a cancelled or returned order can never be reached again after a shipped one is cancelled', () => {
    // shipped orders can only be resolved by delivery outcomes, never cancelled
    expect(ORDER_TRANSITIONS.shipped).not.toContain('cancelled');
  });

  it('asks for a reason on the outcomes that need explaining', () => {
    expect([...REASON_REQUIRED].sort()).toEqual(
      ['cancelled', 'delivery_failed', 'return_requested', 'returned'].sort(),
    );
  });
});

describe('when stock moves', () => {
  it('reserves on confirm, releases on cancel, ships on handover, restocks on return, and otherwise nothing', () => {
    expect(stockEffect('pending_confirmation', 'confirmed')).toBe('reserve');
    expect(stockEffect('confirmed', 'cancelled')).toBe('release');
    expect(stockEffect('ready_to_ship', 'cancelled')).toBe('release');
    expect(stockEffect('ready_to_ship', 'shipped')).toBe('ship');
    expect(stockEffect('return_requested', 'returned')).toBe('restock');
  });

  it('an unconfirmed order holds nothing, so cancelling it touches no stock', () => {
    expect(stockEffect('pending_confirmation', 'cancelled')).toBe('none');
    expect(holdsStock('pending_confirmation')).toBe(false);
  });

  it('every legal transition has exactly one defined effect, and the books balance over any path', () => {
    // Walk every legal path: the reserve/release/ship/restock effects must keep "held" between 0 and 1 and never
    // release, ship or restock something that was not held or shipped.
    const walk = (status: OrderStatus, held: boolean, shipped: boolean, depth: number): void => {
      expect(holdsStock(status)).toBe(held);
      if (depth > 8) return;
      for (const next of ORDER_TRANSITIONS[status]) {
        const effect = stockEffect(status, next);
        let h = held;
        let s = shipped;
        if (effect === 'reserve') {
          expect(h).toBe(false);
          h = true;
        } else if (effect === 'release') {
          expect(h).toBe(true);
          h = false;
        } else if (effect === 'ship') {
          expect(h).toBe(true);
          h = false;
          s = true;
        } else if (effect === 'restock') {
          expect(s).toBe(true);
          s = false;
        }
        walk(next, h, s, depth + 1);
      }
    };
    walk('pending_confirmation', false, false, 0);
  });
});

describe('what can still be edited', () => {
  it('freezes lines and money once stock is held, and everything once final', () => {
    expect(editScope('pending_confirmation')).toBe('full');
    expect(editScope('confirmed')).toBe('contact');
    expect(editScope('ready_to_ship')).toBe('contact');
    expect(editScope('shipped')).toBe('notes');
    expect(editScope('delivered')).toBe('notes');
    expect(editScope('cancelled')).toBe('none');
    expect(editScope('returned')).toBe('none');
  });
});

describe('calculateOrderTotals', () => {
  it('works through a realistic order in paisa', () => {
    const t = calculateOrderTotals({
      lines: [
        { quantity: 2, unitPriceMinor: 125050 }, // 2 x 1250.50
        { quantity: 1, unitPriceMinor: 80000, discountMinor: 5000 },
      ],
      discountMinor: 10000,
      deliveryChargeMinor: 6000,
      advancePaidMinor: 50000,
    });
    expect(t).toEqual({
      lineTotalsMinor: [250100, 75000],
      subtotalMinor: 325100,
      discountMinor: 10000,
      deliveryChargeMinor: 6000,
      totalMinor: 321100,
      advancePaidMinor: 50000,
      codAmountMinor: 271100,
    });
  });

  it('COD is the whole total when nothing was paid in advance, and zero when fully prepaid', () => {
    const base = { lines: [{ quantity: 1, unitPriceMinor: 100000 }], deliveryChargeMinor: 6000 };
    expect(calculateOrderTotals(base).codAmountMinor).toBe(106000);
    expect(calculateOrderTotals({ ...base, advancePaidMinor: 106000 }).codAmountMinor).toBe(0);
  });

  it('names the input at fault', () => {
    const fail = (input: Parameters<typeof calculateOrderTotals>[0]) => {
      try {
        calculateOrderTotals(input);
      } catch (e) {
        expect(e).toBeInstanceOf(OrderTotalsError);
        return (e as OrderTotalsError).field;
      }
      return null;
    };
    const line = { quantity: 1, unitPriceMinor: 1000 };
    expect(fail({ lines: [] })).toBe('lines');
    expect(fail({ lines: [line, { ...line, quantity: 0 }] })).toBe('lines.1.quantity');
    expect(fail({ lines: [{ ...line, quantity: 1.5 }] })).toBe('lines.0.quantity');
    expect(fail({ lines: [{ ...line, unitPriceMinor: -1 }] })).toBe('lines.0.unitPriceMinor');
    expect(fail({ lines: [{ ...line, unitPriceMinor: 12.5 }] })).toBe('lines.0.unitPriceMinor');
    expect(fail({ lines: [{ ...line, discountMinor: 2000 }] })).toBe('lines.0.discountMinor');
    expect(fail({ lines: [line], discountMinor: 1001 })).toBe('discountMinor');
    expect(fail({ lines: [line], deliveryChargeMinor: -5 })).toBe('deliveryChargeMinor');
    expect(fail({ lines: [line], advancePaidMinor: 1001 })).toBe('advancePaidMinor');
    expect(fail({ lines: [{ quantity: 10_000, unitPriceMinor: 2_000_000_000 }] })).toBe(
      'lines.0.quantity',
    );
    expect(fail({ lines: [line], advancePaidMinor: 1000 })).toBeNull();
  });

  it('refuses NaN, Infinity and unsafe numbers instead of producing a total', () => {
    for (const bad of [NaN, Infinity, 2 ** 60]) {
      expect(() => calculateOrderTotals({ lines: [{ quantity: 1, unitPriceMinor: bad }] })).toThrow(
        OrderTotalsError,
      );
      expect(() =>
        calculateOrderTotals({ lines: [{ quantity: 1, unitPriceMinor: 100 }], discountMinor: bad }),
      ).toThrow(OrderTotalsError);
    }
  });

  it('PROPERTY: the figures always add up exactly, and nothing is ever negative', () => {
    const line = fc.record({
      quantity: fc.integer({ min: 1, max: 500 }),
      unitPriceMinor: fc.integer({ min: 0, max: 5_000_000 }),
      discountMinor: fc.integer({ min: 0, max: 100_000 }),
    });
    fc.assert(
      fc.property(
        fc.array(line, { minLength: 1, maxLength: 12 }),
        fc.nat(2_000_000),
        fc.nat(200_000),
        fc.nat(5_000_000),
        (lines, discount, delivery, advance) => {
          let t;
          try {
            t = calculateOrderTotals({
              lines,
              discountMinor: discount,
              deliveryChargeMinor: delivery,
              advancePaidMinor: advance,
            });
          } catch (e) {
            expect(e).toBeInstanceOf(OrderTotalsError); // refused with a reason, never a bad number
            return;
          }
          expect(t.lineTotalsMinor.reduce((a, b) => a + b, 0)).toBe(t.subtotalMinor);
          expect(t.totalMinor).toBe(t.subtotalMinor - t.discountMinor + t.deliveryChargeMinor);
          expect(t.codAmountMinor).toBe(t.totalMinor - t.advancePaidMinor);
          for (const n of [...t.lineTotalsMinor, t.subtotalMinor, t.totalMinor, t.codAmountMinor])
            expect(Number.isSafeInteger(n) && n >= 0 && n <= ORDER_LIMITS.maxMoney).toBe(true);
          lines.forEach((l, i) =>
            expect(t.lineTotalsMinor[i]).toBe(l.quantity * l.unitPriceMinor - l.discountMinor),
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('Bangladeshi phone numbers', () => {
  const canonical = '+8801712345678';
  it('accepts every common way of writing the same number', () => {
    for (const written of [
      '01712345678',
      '01712-345678',
      '01712 345 678',
      '+8801712345678',
      '+880 1712-345678',
      '8801712345678',
      '008801712345678',
      '1712345678',
      '(0171) 234-5678',
      '০১৭১২৩৪৫৬৭৮', // Bangla digits
      '+৮৮০১৭১২৩৪৫৬৭৮',
    ])
      expect(normalizeBdPhone(written), written).toBe(canonical);
  });

  it('refuses what is not a mobile number', () => {
    for (const bad of [
      '',
      '12345',
      '0171234567',
      '017123456789',
      '01212345678',
      '01012345678',
      '+9101712345678',
      'phone me',
      '0171234567a',
      '+8801712345678 ext 5',
    ]) {
      expect(normalizeBdPhone(bad), bad).toBeNull();
    }
  });

  it('covers every mobile operator prefix 013 to 019', () => {
    for (const p of ['013', '014', '015', '016', '017', '018', '019'])
      expect(normalizeBdPhone(`${p}12345678`)).toBe(`+880${p.slice(1)}12345678`);
  });

  it('is idempotent and formats for people', () => {
    expect(normalizeBdPhone(canonical)).toBe(canonical);
    expect(formatBdPhone(canonical)).toBe('01712-345678');
    expect(formatBdPhone('weird')).toBe('weird');
  });
});

describe('the contract and the domain agree', () => {
  it('the API accepts exactly the statuses the state machine knows', () => {
    expect([...OrderStatusSchema.options]).toEqual([...ORDER_STATUSES]);
  });
  it('knows every source a form can offer', () => {
    expect(OrderSource.options).toEqual([...ORDER_SOURCES]);
  });
});
