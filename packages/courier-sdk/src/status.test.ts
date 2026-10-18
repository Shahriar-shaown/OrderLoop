import { describe, expect, it } from 'vitest';
import {
  advanceShipment,
  isFinalShipmentStatus,
  mapPathaoStatus,
  mapSteadfastStatus,
  normalizeSlug,
} from './status.js';
import { SHIPMENT_STATUSES } from './types.js';

describe('Pathao status mapping', () => {
  it('reads events and display text alike', () => {
    for (const v of ['order.delivered', 'Delivered', 'delivered', ' DELIVERED '])
      expect(mapPathaoStatus(v)).toBe('delivered');
    expect(normalizeSlug('Pickup Requested')).toBe('pickup-requested');
    expect(normalizeSlug('order.at-the-sorting-hub')).toBe('at-the-sorting-hub');
    expect(normalizeSlug('picked_up')).toBe('picked-up');
  });

  it('maps every documented step', () => {
    const table: [string, string][] = [
      ['order.created', 'booked'],
      ['order.pickup-requested', 'booked'],
      ['order.assigned-for-pickup', 'booked'],
      ['order.picked', 'picked_up'],
      ['order.at-the-sorting-hub', 'in_transit'],
      ['order.in-transit', 'in_transit'],
      ['order.received-at-last-mile-hub', 'in_transit'],
      ['order.assigned-for-delivery', 'out_for_delivery'],
      ['order.delivered', 'delivered'],
      ['order.partial-delivery', 'partial_delivered'],
      ['order.pickup-failed', 'on_hold'],
      ['order.delivery-failed', 'delivery_failed'],
      ['order.on-hold', 'on_hold'],
      ['order.pickup-cancelled', 'cancelled'],
      ['order.return-id-created', 'returning'],
      ['order.return-in-transit', 'returning'],
      ['order.paid-return', 'returning'],
      ['order.returned', 'returning'],
      ['order.returned-to-merchant', 'returned'],
    ];
    for (const [input, out] of table) expect(mapPathaoStatus(input), input).toBe(out);
  });

  it('does not treat the bare “returned” as back with the seller', () => {
    expect(mapPathaoStatus('order.returned')).toBe('returning');
    expect(mapPathaoStatus('order.returned-to-merchant')).toBe('returned');
  });

  it('says nothing for payment and store events, and “unknown” for what it cannot place', () => {
    for (const v of ['order.paid', 'order.updated', 'store.created', 'store.updated'])
      expect(mapPathaoStatus(v), v).toBeNull();
    expect(mapPathaoStatus('order.teleported')).toBe('unknown');
  });
});

describe('Steadfast status mapping', () => {
  it('maps every documented status', () => {
    const table: [string, string][] = [
      ['in_review', 'booked'],
      ['pending', 'booked'],
      ['hold', 'on_hold'],
      ['delivered_approval_pending', 'delivered'],
      ['delivered', 'delivered'],
      ['partial_delivered_approval_pending', 'partial_delivered'],
      ['partial_delivered', 'partial_delivered'],
      ['cancelled_approval_pending', 'cancelled'],
      ['cancelled', 'cancelled'],
      ['unknown_approval_pending', 'unknown'],
      ['unknown', 'unknown'],
    ];
    for (const [input, out] of table) expect(mapSteadfastStatus(input), input).toBe(out);
    expect(mapSteadfastStatus('Delivered')).toBe('delivered');
    expect(mapSteadfastStatus('something_new')).toBe('unknown');
  });
});

describe('moving a shipment forward', () => {
  it('accepts the normal path and rejects going backwards', () => {
    const path = ['booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered'] as const;
    for (let i = 0; i < path.length - 1; i++)
      expect(advanceShipment(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toEqual({
        apply: true,
      });
    expect(advanceShipment('delivered', 'in_transit')).toEqual({
      apply: false,
      reason: 'out_of_order',
    });
    expect(advanceShipment('in_transit', 'picked_up')).toEqual({
      apply: false,
      reason: 'out_of_order',
    });
    expect(advanceShipment('in_transit', 'booked')).toEqual({
      apply: false,
      reason: 'out_of_order',
    });
  });

  it('skips steps a late webhook never reported, because the parcel is further on', () => {
    expect(advanceShipment('booked', 'delivered')).toEqual({ apply: true });
    expect(advanceShipment('booked', 'in_transit')).toEqual({ apply: true });
  });

  it('allows a failed delivery to be retried and a delivered parcel to be returned', () => {
    expect(advanceShipment('delivery_failed', 'out_for_delivery')).toEqual({ apply: true });
    expect(advanceShipment('out_for_delivery', 'delivery_failed')).toEqual({ apply: true });
    expect(advanceShipment('delivered', 'returning')).toEqual({ apply: true });
    expect(advanceShipment('returning', 'returned')).toEqual({ apply: true });
  });

  it('repeats are duplicates, not changes', () => {
    for (const s of SHIPMENT_STATUSES.filter((x) => x !== 'unknown'))
      expect(advanceShipment(s, s), s).toEqual({ apply: false, reason: 'duplicate' });
  });

  it('unknown and information-only events never move anything', () => {
    for (const s of SHIPMENT_STATUSES) {
      expect(advanceShipment(s, 'unknown')).toEqual({
        apply: false,
        reason: s === 'unknown' ? 'unknown_status' : 'unknown_status',
      });
      expect(advanceShipment(s, null)).toEqual({ apply: false, reason: 'not_a_status' });
    }
  });

  it('returned and cancelled are final: nothing follows them', () => {
    for (const final of ['returned', 'cancelled'] as const) {
      expect(isFinalShipmentStatus(final)).toBe(true);
      for (const s of SHIPMENT_STATUSES.filter((x) => x !== final && x !== 'unknown'))
        expect(advanceShipment(final, s), `${final} -> ${s}`).toEqual({
          apply: false,
          reason: 'out_of_order',
        });
    }
    expect(isFinalShipmentStatus('delivered')).toBe(false);
  });

  it('PROPERTY: any order of events leaves the shipment on a status reachable by legal steps only', () => {
    // Replay every permutation of a shuffled event list: whatever order they arrive in, applying only legal moves ends somewhere legal
    // and never visits a status twice in a row.
    const events = [
      'booked',
      'picked_up',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'delivery_failed',
      'returning',
      'returned',
    ] as const;
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let run = 0; run < 500; run++) {
      const list = Array.from({ length: 12 }, () => events[Math.floor(rand() * events.length)]!);
      let current: (typeof SHIPMENT_STATUSES)[number] = 'booked';
      for (const e of list) {
        const a = advanceShipment(current, e);
        if (a.apply) {
          expect(current).not.toBe(e);
          current = e;
        }
      }
      expect(SHIPMENT_STATUSES).toContain(current);
    }
  });
});
