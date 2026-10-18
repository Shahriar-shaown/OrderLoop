import { beforeEach, describe, expect, it } from 'vitest';
import { CourierError } from './errors.js';
import { MOCK_BOOKINGS, MockAdapter, type MockSettings } from './mock.js';
import type { BookingRequest } from './types.js';

const booking = (over: Partial<BookingRequest> = {}): BookingRequest => ({
  reference: 'OL-1001',
  recipient: { name: 'Rina', phone: '+8801712345678', address: 'House 5, Road 3, Dhaka' },
  codAmountMinor: 100_000,
  itemDescription: 'Tee',
  itemQuantity: 1,
  ...over,
});
let n = 0;
const make = (settings: MockSettings = {}) => new MockAdapter(`scope-${++n}`, settings);
const fail = async (p: Promise<unknown>): Promise<CourierError> => {
  try {
    await p;
  } catch (e) {
    return e as CourierError;
  }
  throw new Error('expected a failure');
};
beforeEach(() => MOCK_BOOKINGS.clear());

describe('the simulated courier', () => {
  it('is plainly simulated, and nothing it returns looks like a real parcel', async () => {
    const a = make();
    expect(a.simulated).toBe(true);
    const r = await a.book(booking());
    expect(r.consignmentId).toMatch(/^SIM-[0-9A-F]{10}$/);
    expect(r.trackingUrl).toMatch(/^https:\/\/simulated\.invalid\//);
    expect((r.raw as { simulated: boolean }).simulated).toBe(true);
    expect((await a.verifyConnection()).details[0]).toMatch(/Simulated courier/);
  });

  it('quotes a simulated fee and can say a place is not serviceable', async () => {
    expect(
      await make({ feeMinor: 8000 }).quote({
        recipient: { address: 'x' },
        codAmountMinor: 100_000,
      }),
    ).toMatchObject({ serviceable: true, feeMinor: 8000, codFeeMinor: 1000 });
    expect(
      await make({ serviceable: false }).quote({ recipient: { address: 'x' }, codAmountMinor: 0 }),
    ).toMatchObject({ serviceable: false });
  });

  it('refuses COD with paisa like the real ones do', async () => {
    expect((await fail(make().book(booking({ codAmountMinor: 100_050 })))).kind).toBe(
      'unsupported',
    );
  });

  it('without a reference lookup, booking the same reference twice makes two parcels (the danger our controls must prevent)', async () => {
    const a = make();
    const first = await a.book(booking());
    const second = await a.book(booking());
    expect(second.consignmentId).not.toBe(first.consignmentId);
    expect(MOCK_BOOKINGS.get([...MOCK_BOOKINGS.keys()][0]!)).toHaveLength(2);
    expect(await a.findByReference('OL-1001')).toBeNull();
    expect(a.capabilities.duplicateProtection).toBe('none');
  });

  it('with a reference lookup it finds an existing booking and returns the same parcel', async () => {
    const a = make({ referenceLookup: true });
    const first = await a.book(booking());
    expect((await a.book(booking())).consignmentId).toBe(first.consignmentId);
    expect(await a.findByReference('OL-1001')).toMatchObject({
      consignmentId: first.consignmentId,
    });
    expect(await a.findByReference('OTHER')).toBeNull();
  });

  it('can fail in every way a real courier can', async () => {
    expect((await fail(make({ outcome: 'validation_error' }).book(booking()))).kind).toBe(
      'validation',
    );
    const limited = await fail(make({ outcome: 'rate_limited' }).book(booking()));
    expect([limited.kind, limited.outcomeUnknown]).toEqual(['rate_limited', false]);
    const down = await fail(make({ outcome: 'unavailable' }).book(booking()));
    expect([down.kind, down.outcomeUnknown]).toEqual(['unavailable', true]);
  });

  it('a timeout before booking books nothing; a timeout after booking leaves a parcel behind', async () => {
    const before = make({ outcome: 'timeout_before_booking' });
    expect((await fail(before.book(booking()))).outcomeUnknown).toBe(true);
    expect(await before.findByReference('OL-1001')).toBeNull();
    const after = make({ outcome: 'timeout_after_booking', referenceLookup: true });
    expect((await fail(after.book(booking()))).outcomeUnknown).toBe(true);
    expect(await after.findByReference('OL-1001')).toMatchObject({ status: 'booked' }); // it really exists
  });

  it('“_once” outcomes misbehave on the first attempt only', async () => {
    const a = make({ outcome: 'unavailable_once' });
    await fail(a.book(booking()));
    expect((await a.book(booking())).status).toBe('booked');
    // a different reference misbehaves once too
    await fail(a.book(booking({ reference: 'OL-1002' })));
  });

  it('tracks what it was last told, and can cancel only before pickup', async () => {
    const a = make();
    expect(await a.track({ consignmentId: 'SIM-1', reference: 'r' })).toMatchObject({
      status: 'booked',
    });
    expect(
      await a.track({
        consignmentId: 'SIM-1',
        reference: 'r',
        last: { providerStatus: 'in_transit', status: 'in_transit' },
      }),
    ).toMatchObject({ providerStatus: 'in_transit', status: 'in_transit' });
    expect(await a.cancel!({ consignmentId: 'SIM-1', reference: 'r' })).toEqual({
      cancelled: true,
    });
    expect(
      await a.cancel!({
        consignmentId: 'SIM-1',
        reference: 'r',
        last: { providerStatus: 'picked_up', status: 'picked_up' },
      }),
    ).toMatchObject({ cancelled: false });
  });

  it('has simulated locations', async () => {
    const a = make();
    expect((await a.locations.cities())[0]!.name).toMatch(/simulated/);
    expect((await a.locations.areas(10))[0]).toMatchObject({ homeDelivery: true });
  });
});
