import { describe, expect, it } from 'vitest';
import { ORDER_TRANSITIONS, canTransition, type OrderStatus } from '@orderloop/domain';
import { SHIPMENT_STATUS_VALUES } from '@orderloop/contracts';
import { planOrderMoves } from './order-sync.js';

const ORDER_STATES = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];

describe('bringing an order in line with a shipment update', () => {
  it('carries a handed-over order forward one allowed step at a time', () => {
    expect(planOrderMoves('ready_to_ship', 'picked_up').steps).toEqual(['shipped']);
    expect(planOrderMoves('ready_to_ship', 'in_transit').steps).toEqual(['shipped', 'in_transit']);
    expect(planOrderMoves('ready_to_ship', 'delivered').steps).toEqual(['shipped', 'delivered']);
    expect(planOrderMoves('shipped', 'out_for_delivery').steps).toEqual(['in_transit']);
    expect(planOrderMoves('in_transit', 'delivered').steps).toEqual(['delivered']);
    expect(planOrderMoves('in_transit', 'delivery_failed').steps).toEqual(['delivery_failed']);
    expect(planOrderMoves('delivery_failed', 'in_transit').steps).toEqual(['in_transit']);
  });

  it('turns a returning parcel into a return request, through a failed delivery when it has to', () => {
    expect(planOrderMoves('delivery_failed', 'returning').steps).toEqual(['return_requested']);
    expect(planOrderMoves('delivered', 'returning').steps).toEqual(['return_requested']);
    expect(planOrderMoves('in_transit', 'returning').steps).toEqual([
      'delivery_failed',
      'return_requested',
    ]);
  });

  it('does nothing when the order is already there or the update asks for nothing', () => {
    expect(planOrderMoves('in_transit', 'in_transit')).toEqual({ steps: [], note: null });
    for (const s of ['booked', 'on_hold', 'cancelled', 'unknown'] as const)
      expect(planOrderMoves('ready_to_ship', s)).toEqual({ steps: [], note: null });
  });

  it('never confirms, cancels, reopens or restocks an order, and says when a person has to act', () => {
    for (const from of ['pending_confirmation', 'confirmed', 'cancelled', 'returned'] as const) {
      const p = planOrderMoves(from, 'delivered');
      expect(p.steps, from).toEqual([]);
      expect(p.note, from).toMatch(/left as/);
    }
    expect(planOrderMoves('return_requested', 'in_transit').steps).toEqual([]);
    expect(planOrderMoves('in_transit', 'returned')).toMatchObject({
      steps: [],
      note: expect.stringContaining('mark it returned'),
    });
    expect(planOrderMoves('in_transit', 'partial_delivered').note).toMatch(/partial delivery/);
  });

  it('only ever proposes moves the order state machine allows, from any order state and any shipment status', () => {
    for (const from of ORDER_STATES)
      for (const s of SHIPMENT_STATUS_VALUES) {
        let at = from;
        for (const step of planOrderMoves(from, s).steps) {
          expect(canTransition(at, step), `${from} -> ${step} (${s})`).toBe(true);
          expect(['cancelled', 'returned', 'confirmed']).not.toContain(step);
          at = step;
        }
      }
  });
});
