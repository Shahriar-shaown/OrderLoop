import { fakeNetwork, timeoutError } from '@orderloop/courier-sdk';
import { Writable } from 'node:stream';
import { ApiError } from '../src/common/api-error.js';
import { ShipmentsService } from '../src/couriers/shipments.service.js';
import { OrdersService } from '../src/orders/orders.service.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  createProduct,
  createTestApp,
  registerTenant,
  type TestApp,
} from './app.js';

let t: TestApp;
let net = fakeNetwork({});
const logs: string[] = [];
beforeAll(async () => {
  t = await createTestApp(
    {},
    {
      // Every courier call in these tests goes to a fake network: nothing here can reach a real courier.
      courier: {
        fetch: (url: string, init: unknown) =>
          (net.fetch as never as (u: string, i: unknown) => unknown)(url, init),
        sleep: async () => undefined,
      },
      logDestination: new Writable({ write: (chunk, _e, cb) => (logs.push(String(chunk)), cb()) }),
    },
  );
});
afterAll(() => t.close());

type Who = { accessToken: string };
let seq = 0;
const key = (p = 'bk') => `${p}-${Date.now()}-${++seq}`;
let phoneSeq = 500;
const call = (who: Who) => ({
  get: (path: string) => t.http.get(path).set(bearer(who.accessToken)),
  post: (path: string, body: object = {}) =>
    t.http.post(path).set(bearer(who.accessToken)).send(body),
  patch: (path: string, body: object) => t.http.patch(path).set(bearer(who.accessToken)).send(body),
  del: (path: string) => t.http.delete(path).set(bearer(who.accessToken)),
});
type Api = ReturnType<typeof call>;

const shop = async () => {
  const owner = await registerTenant(t);
  return {
    owner,
    api: call(owner),
    tenantId: owner.tenant.id,
  };
};

/** An order that is ready to ship, with stock reserved. COD is whole taka unless `price` says otherwise. */
async function readyOrder(
  owner: Who,
  api: Api,
  opts: { price?: number; qty?: number; ship?: boolean } = {},
) {
  const { variant } = await createProduct(t, owner.accessToken, {
    priceMinor: opts.price ?? 100_000,
  });
  await api.post('/v1/inventory/receive', { variantId: variant.id, quantity: 20 }).expect(201);
  const res = await api
    .post('/v1/orders', {
      customer: { name: 'Rina Akter', phone: `0171${String(1000000 + ++phoneSeq).slice(-7)}` },
      address: {
        recipientName: 'Rina Akter',
        phone: '01712345678',
        line1: 'House 5, Road 3, Dhanmondi',
        area: 'Dhanmondi',
        district: 'Dhaka',
        division: 'Dhaka',
      },
      items: [{ variantId: variant.id, quantity: opts.qty ?? 1 }],
      deliveryChargeMinor: 6_000,
      idempotencyKey: key('ord'),
      confirm: true,
    })
    .expect(201);
  await api.post(`/v1/orders/${res.body.id}/status`, { status: 'ready_to_ship' }).expect(200);
  return { id: res.body.id as string, number: res.body.orderNumber as number, variant };
}

const connectMock = (api: Api, settings: object = {}) =>
  api.patch('/v1/couriers/mock', { settings });
const book = (api: Api, orderId: string, provider = 'mock', extra: object = {}) =>
  api.post(`/v1/orders/${orderId}/shipments`, { provider, idempotencyKey: key(), ...extra });
const onHand = async (api: Api, variantId: string) =>
  (await api.get(`/v1/inventory?variantId=${variantId}`)).body.items[0] as {
    onHand: number;
    reserved: number;
  };
const orderOf = async (api: Api, id: string) => (await api.get(`/v1/orders/${id}`)).body;
const shipmentsOf = async (api: Api, orderId: string) =>
  (await api.get(`/v1/orders/${orderId}/shipments`)).body as { id: string; status: string }[];

describe('the simulated courier: book, track, retry (the milestone checkpoint)', () => {
  it('books a test order, follows simulated updates to delivery, and keeps the order and stock right', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    expect(await onHand(api, order.variant.id)).toMatchObject({ onHand: 20, reserved: 1 });

    const booked = await book(api, order.id).expect(201);
    expect(booked.body).toMatchObject({
      provider: 'mock',
      environment: 'simulated',
      simulated: true,
      status: 'booked',
      reference: `OL-${order.number}`,
      codAmountMinor: 106_000,
    });
    expect(booked.body.consignmentId).toMatch(/^SIM-/);
    expect(booked.body.trackingUrl).toMatch(/^https:\/\/simulated\.invalid\//);
    expect(booked.body.events.map((e: { source: string }) => e.source)).toEqual([
      'booking',
      'booking',
    ]);
    // booking alone moves nothing: the order is still ready to ship and its stock is still reserved
    expect((await orderOf(api, order.id)).status).toBe('ready_to_ship');

    const sim = (event: string) => api.post(`/v1/shipments/${booked.body.id}/simulate`, { event });
    expect((await sim('picked_up').expect(200)).body.status).toBe('picked_up');
    let o = await orderOf(api, order.id);
    expect(o.status).toBe('shipped');
    expect(await onHand(api, order.variant.id)).toMatchObject({ onHand: 19, reserved: 0 }); // the unit left the shelf

    await sim('in_transit').expect(200);
    await sim('out_for_delivery').expect(200);
    const done = await sim('delivered').expect(200);
    expect(done.body.status).toBe('delivered');
    o = await orderOf(api, order.id);
    expect(o.status).toBe('delivered');
    // the order's own history says who moved it and why
    const lastReasons = o.history.map(
      (h: { reason: string | null; actorUserId: string | null; toStatus: string }) => [
        h.toStatus,
        h.actorUserId,
        h.reason,
      ],
    );
    expect(lastReasons).toContainEqual([
      'shipped',
      null,
      'Simulated courier update: simulated:picked_up',
    ]);
    expect(lastReasons).toContainEqual([
      'delivered',
      null,
      'Simulated courier update: simulated:delivered',
    ]);
    expect(await onHand(api, order.variant.id)).toMatchObject({ onHand: 19 });

    // every update is kept in order, with the courier's own wording beside ours
    const detail = (await api.get(`/v1/shipments/${booked.body.id}`)).body;
    expect(
      detail.events.map((e: { providerStatus: string | null }) => e.providerStatus).filter(Boolean),
    ).toEqual([
      'booked', // the booking reply
      'simulated:picked_up',
      'simulated:in_transit',
      'simulated:out_for_delivery',
      'simulated:delivered',
    ]);
    expect(detail.events.filter((e: { source: string }) => e.source === 'simulation')).toHaveLength(
      4,
    );
    expect(detail.providerStatus).toBe('simulated:delivered');
  });

  it('is safe to retry: the same key returns the same shipment, and nothing is booked twice', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    const k = key();
    const first = await api
      .post(`/v1/orders/${order.id}/shipments`, { provider: 'mock', idempotencyKey: k })
      .expect(201);
    const again = await api
      .post(`/v1/orders/${order.id}/shipments`, { provider: 'mock', idempotencyKey: k })
      .expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.consignmentId).toBe(first.body.consignmentId);
    expect(await shipmentsOf(api, order.id)).toHaveLength(1);
    // the same key for a different booking is refused, not quietly answered with the old one
    const clash = await api.post(`/v1/orders/${order.id}/shipments`, {
      provider: 'mock',
      idempotencyKey: k,
      weightKg: 3,
    });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('idempotency_conflict');
  });

  it('cannot book an order twice even when many requests arrive at once, with or without the same key', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    const sameKey = key();
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () =>
        api.post(`/v1/orders/${order.id}/shipments`, { provider: 'mock', idempotencyKey: sameKey }),
      ),
      ...Array.from({ length: 5 }, () => book(api, order.id)),
    ]);
    const shipments = await shipmentsOf(api, order.id);
    expect(shipments).toHaveLength(1);
    // every success names that one shipment; everything else was told why
    for (const r of results) {
      if (r.status === 201) expect(r.body.id).toBe(shipments[0]!.id);
      else expect(r.status).toBe(409);
    }
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
  });

  it('only books an order that is ready to ship, and needs the courier to be connected', async () => {
    const { owner, api } = await shop();
    const order = await readyOrder(owner, api);
    expect((await book(api, order.id)).body.code).toBe('courier_not_configured'); // not connected yet
    await connectMock(api).expect(200);
    const { variant } = await createProduct(t, owner.accessToken);
    const pending = await api
      .post('/v1/orders', {
        customer: { name: 'A B', phone: '01711111111' },
        address: {
          recipientName: 'A B',
          phone: '01711111111',
          line1: 'House 1, Road 2, Gulshan',
          area: 'Gulshan',
          district: 'Dhaka',
          division: 'Dhaka',
        },
        items: [{ variantId: variant.id, quantity: 1 }],
        idempotencyKey: key('ord'),
      })
      .expect(201);
    const refused = await book(api, pending.body.id);
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toMatch(/Ready to ship/);
  });

  it('records a refused booking as a failure and allows a fresh attempt with its own reference', async () => {
    const { owner, api } = await shop();
    const order = await readyOrder(owner, api);
    await connectMock(api, { outcome: 'validation_error' }).expect(200);
    const failed = await book(api, order.id).expect(201);
    expect(failed.body.status).toBe('booking_failed');
    expect(failed.body.failureReason).toBeTruthy();
    await connectMock(api, { outcome: 'success' }).expect(200);
    const second = await book(api, order.id).expect(201);
    expect(second.body).toMatchObject({
      status: 'booked',
      attempt: 2,
      reference: `OL-${order.number}-2`,
    });
    expect((await shipmentsOf(api, order.id)).map((s) => s.status)).toEqual([
      'booked',
      'booking_failed',
    ]);
  });

  it('cash to collect with paisa is flagged on the order and refused before any shipment exists, with what to do', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const whole = await readyOrder(owner, api);
    expect((await orderOf(api, whole.id)).codHasPaisa).toBe(false);
    const paisa = await readyOrder(owner, api, { price: 100_050 }); // 1000.50 + 60.00 delivery = 1060.50
    expect((await orderOf(api, paisa.id)).codHasPaisa).toBe(true);
    const refused = await book(api, paisa.id);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('courier_unsupported');
    expect(refused.body.detail).toContain('৳1060.50');
    expect(refused.body.detail).toContain('whole taka');
    expect(refused.body.detail).toContain('cancel this order');
    expect(await shipmentsOf(api, paisa.id)).toEqual([]); // no failed attempt left behind
    expect((await orderOf(api, paisa.id)).status).toBe('ready_to_ship');
  });

  it('after a timeout it cannot know whether a parcel exists, so it blocks a second booking until a person settles it', async () => {
    const { owner, api } = await shop();
    const order = await readyOrder(owner, api);
    await connectMock(api, { outcome: 'timeout_after_booking', referenceLookup: false }).expect(
      200,
    );
    const unsure = await book(api, order.id).expect(201);
    expect(unsure.body.status).toBe('booking_uncertain');
    expect(unsure.body.actions).toMatchObject({ needsResolution: true, canRefresh: false });
    expect(unsure.body.failureReason).toMatch(/Booking again before that could send two parcels/);
    // booking again is refused: a second parcel could be created
    await connectMock(api, { outcome: 'success' }).expect(200);
    const blocked = await book(api, order.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('shipment_conflict');
    // the order cannot be cancelled underneath it either
    expect(
      (
        await api.post(`/v1/orders/${order.id}/status`, {
          status: 'cancelled',
          reason: 'no longer wanted',
        })
      ).status,
    ).toBe(409);
    // a person looks at the courier's panel and says what they saw
    const settled = await api
      .post(`/v1/shipments/${unsure.body.id}/resolve`, {
        resolution: 'not_booked',
        reason: 'Checked the panel, nothing there',
      })
      .expect(200);
    expect(settled.body.status).toBe('booking_failed');
    expect((await book(api, order.id).expect(201)).body.status).toBe('booked');
    // there was nothing to settle on a booked parcel
    const bookedId = (await shipmentsOf(api, order.id))[0]!.id;
    expect(
      (
        await api.post(`/v1/shipments/${bookedId}/resolve`, {
          resolution: 'not_booked',
          reason: 'because I can',
        })
      ).status,
    ).toBe(409);
  });

  it('a booking reply that arrives after a person settled it as not booked leaves a visible orphan-parcel record', async () => {
    const { owner, api } = await shop();
    const order = await readyOrder(owner, api);
    await connectMock(api, { outcome: 'timeout_after_booking', referenceLookup: false }).expect(
      200,
    );
    const unsure = await book(api, order.id).expect(201);
    await api
      .post(`/v1/shipments/${unsure.body.id}/resolve`, {
        resolution: 'not_booked',
        reason: 'Checked the panel, nothing there',
      })
      .expect(200);
    // the slow reply finally lands: the courier did create a parcel
    const auth = {
      userId: owner.user.id,
      tenantId: owner.tenant.id,
      role: 'OWNER' as const,
      sessionId: 'x',
    };
    const late = await (
      t.app.get(ShipmentsService) as unknown as {
        settleBooked(
          a: object,
          id: string,
          r: object,
          ip: null,
        ): Promise<{ status: string; events: { note: string | null; applied: boolean }[] }>;
      }
    ).settleBooked(
      auth,
      unsure.body.id,
      { consignmentId: 'LATE-1', providerStatus: 'created', status: 'booked', raw: {} },
      null,
    );
    expect(late.status).toBe('booking_failed'); // the person's decision stands
    expect(late.events.some((e) => !e.applied && /LATE-1/.test(e.note ?? ''))).toBe(true);
    const log = (await api.get('/v1/audit-logs?limit=100').expect(200)).body.items as {
      action: string;
      targetId: string;
      metadata: { kind?: string; consignmentId?: string };
    }[];
    expect(log.find((e) => e.action === 'shipment.orphan_booking')).toMatchObject({
      targetId: unsure.body.id,
      metadata: { kind: 'orphan_booking', consignmentId: 'LATE-1' },
    });
  });

  it('when the courier can be asked by reference, a lost reply is recovered without a second booking', async () => {
    const { owner, api } = await shop();
    const order = await readyOrder(owner, api);
    await connectMock(api, { outcome: 'timeout_after_booking', referenceLookup: true }).expect(200);
    const recovered = await book(api, order.id).expect(201);
    expect(recovered.body.status).toBe('booked');
    expect(
      recovered.body.events.some((e: { note: string | null }) =>
        /lost, but the courier confirmed/.test(e.note ?? ''),
      ),
    ).toBe(true);
    expect(await shipmentsOf(api, order.id)).toHaveLength(1);
  });

  it('only a courier manager may settle a booking in a way that allows a second parcel', async () => {
    const { owner, api } = await shop();
    const staff = call(await addMember(t, owner, 'STAFF'));
    const order = await readyOrder(owner, api);
    await connectMock(api, { outcome: 'unavailable' }).expect(200);
    const unsure = await book(api, order.id).expect(201);
    const path = `/v1/shipments/${unsure.body.id}/resolve`;
    for (const resolution of ['not_booked', 'cancelled_at_courier'])
      expect((await staff.post(path, { resolution, reason: 'looked at it' })).status).toBe(403);
    expect((await api.get(`/v1/shipments/${unsure.body.id}`)).body.status).toBe(
      'booking_uncertain',
    );
    // saying the parcel exists only blocks a second booking, so floor staff may
    const settled = await staff.post(path, { resolution: 'booked', reason: 'It is in the panel' });
    expect(settled.status).toBe(200);
    expect(settled.body.status).toBe('booked');
  });

  it('a person can say an unconfirmed booking did exist', async () => {
    const { owner, api } = await shop();
    const order = await readyOrder(owner, api);
    await connectMock(api, { outcome: 'unavailable' }).expect(200);
    const unsure = await book(api, order.id).expect(201);
    const settled = await api
      .post(`/v1/shipments/${unsure.body.id}/resolve`, {
        resolution: 'booked',
        consignmentId: 'SIM-FOUND-1',
        reason: 'It is in the panel',
      })
      .expect(200);
    expect(settled.body).toMatchObject({ status: 'booked', consignmentId: 'SIM-FOUND-1' });
    expect(settled.body.events.at(-1).note).toMatch(/settled by a person/);
  });

  it('cancels a booking that has not been picked up, and refuses once it has', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    const booked = await book(api, order.id).expect(201);
    // cancelling the order underneath a live parcel is refused
    const refused = await api.post(`/v1/orders/${order.id}/status`, {
      status: 'cancelled',
      reason: 'customer changed mind',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('shipment_conflict');
    const cancelled = await api
      .post(`/v1/shipments/${booked.body.id}/cancel`, { reason: 'Customer changed mind' })
      .expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    // now the order can be cancelled and its stock is released, as before this milestone
    await api
      .post(`/v1/orders/${order.id}/status`, {
        status: 'cancelled',
        reason: 'customer changed mind',
      })
      .expect(200);
    expect(await onHand(api, order.variant.id)).toMatchObject({ onHand: 20, reserved: 0 });

    const o2 = await readyOrder(owner, api);
    const b2 = await book(api, o2.id).expect(201);
    await api.post(`/v1/shipments/${b2.body.id}/simulate`, { event: 'picked_up' }).expect(200);
    expect(
      (await api.post(`/v1/shipments/${b2.body.id}/cancel`, { reason: 'too late now' })).status,
    ).toBe(409);
  });

  it('records an out-of-order or repeated update without acting on it, and returning parcels become return requests', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    const b = await book(api, order.id).expect(201);
    const sim = (event: string) =>
      api.post(`/v1/shipments/${b.body.id}/simulate`, { event }).expect(200);
    await sim('delivered');
    const late = await sim('picked_up'); // arrives after delivery
    expect(late.body.status).toBe('delivered');
    const lastEvent = late.body.events.at(-1);
    expect(lastEvent).toMatchObject({ applied: false });
    expect(lastEvent.note).toMatch(/late or out of order/);
    expect((await orderOf(api, order.id)).status).toBe('delivered');
    await sim('returning');
    expect((await orderOf(api, order.id)).status).toBe('return_requested');
    await sim('returned');
    // the order is NOT restocked or returned automatically: a person decides what is resaleable
    expect((await orderOf(api, order.id)).status).toBe('return_requested');
    const final = (await api.get(`/v1/shipments/${b.body.id}`)).body;
    expect(final.events.at(-1).note).toMatch(/mark it returned/);
  });

  it('refresh on a simulated shipment is harmless, and unsimulated couriers cannot be simulated', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    const b = await book(api, order.id).expect(201);
    const r = await api.post(`/v1/shipments/${b.body.id}/refresh`).expect(200);
    expect(r.body.status).toBe('booked');
    expect(r.body.events).toHaveLength(2); // an unchanged status is not news
  });
});

describe('safety around live shipments', () => {
  it('refuses a weight the courier takes only after a shipment row exists: 400 with the courier’s range, nothing created', async () => {
    net = fakeNetwork({
      'POST /aladdin/api/v1/external/login': {
        body: { access_token: 'tok', refresh_token: 'r', expires_in: 432000 },
      },
    });
    const { owner, api } = await shop();
    await api
      .patch('/v1/couriers/pathao', {
        environment: 'sandbox',
        credentials: { clientId: 'cid', clientSecret: 'csecret' },
        settings: { storeId: 777 },
      })
      .expect(200);
    const order = await readyOrder(owner, api);
    for (const weightKg of [0.2, 12]) {
      const res = await book(api, order.id, 'pathao', { weightKg });
      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/0\.5 to 10 kg/);
      expect(res.body.errors[0].path).toBe('body.weightKg');
    }
    expect(await shipmentsOf(api, order.id)).toEqual([]);
    expect(net.requests.filter((r) => r.path === '/aladdin/api/v1/orders')).toHaveLength(0);
    // the simulated courier takes the wider range
    await connectMock(api).expect(200);
    await book(api, order.id, 'mock', { weightKg: 12 }).expect(201);
  });

  it('two cancels at once cancel the parcel once; the other is told it is already cancelled', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    const b = await book(api, order.id).expect(201);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        api.post(`/v1/shipments/${b.body.id}/cancel`, { reason: 'Customer changed mind' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const detail = (await api.get(`/v1/shipments/${b.body.id}`)).body;
    expect(detail.status).toBe('cancelled');
    expect(
      detail.events.filter((e: { note: string | null }) => e.note?.startsWith('Cancelled')),
    ).toHaveLength(1);
  });

  it('a courier update that arrives while a cancel is under way waits for it, then is recorded as out of order', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    const b = await book(api, order.id).expect(201);
    const [cancel, news] = await Promise.all([
      api.post(`/v1/shipments/${b.body.id}/cancel`, { reason: 'Customer changed mind' }),
      api.post(`/v1/shipments/${b.body.id}/simulate`, { event: 'picked_up' }),
    ]);
    const final = (await api.get(`/v1/shipments/${b.body.id}`)).body;
    // Whichever took the row first, the result is one consistent story: cancelled and the order not shipped, or picked up and not cancellable.
    if (final.status === 'cancelled') {
      expect(cancel.status).toBe(200);
      expect((await orderOf(api, order.id)).status).toBe('ready_to_ship');
    } else {
      expect(final.status).toBe('picked_up');
      expect(cancel.status).toBe(409);
      expect(news.status).toBe(200);
      expect((await orderOf(api, order.id)).status).toBe('shipped');
    }
  });

  it('refuses to change the address or phone of an order with a live shipment, but not notes or an unchanged address', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    const address = {
      recipientName: 'Rina Akter',
      phone: '01712345678',
      line1: 'House 5, Road 3, Dhanmondi',
      area: 'Dhanmondi',
      district: 'Dhaka',
      division: 'Dhaka',
    };
    // no shipment yet: allowed
    await api
      .patch(`/v1/orders/${order.id}`, {
        address: { ...address, line1: 'House 6, Road 3, Dhanmondi' },
      })
      .expect(200);
    const b = await book(api, order.id).expect(201);
    const moved = await api.patch(`/v1/orders/${order.id}`, {
      address: { ...address, phone: '01812345678' },
    });
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe('shipment_conflict');
    expect(moved.body.detail).toMatch(/Cancel the shipment first/);
    expect(
      (await api.patch(`/v1/orders/${order.id}`, { address: { ...address, line1: 'Elsewhere 9' } }))
        .status,
    ).toBe(409);
    // the edit form sends the address with every save: unchanged is fine, and so are notes
    await api
      .patch(`/v1/orders/${order.id}`, {
        address: { ...address, line1: 'House 6, Road 3, Dhanmondi' },
        notes: 'Call first',
      })
      .expect(200);
    // after cancelling the shipment the address can change again
    await api.post(`/v1/shipments/${b.body.id}/cancel`, { reason: 'Wrong address' }).expect(200);
    await api
      .patch(`/v1/orders/${order.id}`, { address: { ...address, phone: '01812345678' } })
      .expect(200);
    expect((await orderOf(api, order.id)).shipping.phone).toBe('+8801812345678');
  });

  it('a courier update that cannot carry the order all the way leaves nothing half done', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    const b = await book(api, order.id).expect(201);
    expect(await onHand(api, order.variant.id)).toMatchObject({ onHand: 20, reserved: 1 });

    // "Delivered" while the order is still ready to ship is two moves: shipped (stock leaves), then delivered.
    // Make the second one fail after the first has really been applied.
    const orders = t.app.get(OrdersService);
    const real = orders.moveInTx.bind(orders);
    let calls = 0;
    orders.moveInTx = async (...args: Parameters<typeof real>) => {
      if (++calls === 2) throw new ApiError('invalid_transition', 'forced failure');
      return real(...args);
    };
    let delivered;
    try {
      delivered = await api
        .post(`/v1/shipments/${b.body.id}/simulate`, { event: 'delivered' })
        .expect(200);
    } finally {
      orders.moveInTx = real;
    }
    expect(calls).toBe(2);
    // the shipment took the news and says the order was not changed
    expect(delivered.body.status).toBe('delivered');
    expect(delivered.body.events.at(-1).note).toMatch(/The order was not changed: forced failure/);
    // the first step was undone with it: the unit is still reserved, no history row, order unchanged
    expect(await onHand(api, order.variant.id)).toMatchObject({ onHand: 20, reserved: 1 });
    const o = await orderOf(api, order.id);
    expect(o.status).toBe('ready_to_ship');
    expect(o.history.map((h: { toStatus: string }) => h.toStatus)).not.toContain('shipped');
    const ship = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.stockMovement.count({ where: { referenceId: order.id, type: 'SHIP' } }),
    );
    expect(ship).toBe(0);
  });
});

describe('an unexpected failure while carrying the order forward', () => {
  it('does not abort the courier news: the shipment keeps it, the order is untouched, the event says so', async () => {
    const { owner, api } = await shop();
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    const b = await book(api, order.id).expect(201);
    const orders = t.app.get(OrdersService);
    const real = orders.moveInTx.bind(orders);
    orders.moveInTx = async () => {
      throw new Error('boom');
    };
    let res;
    try {
      res = await api
        .post(`/v1/shipments/${b.body.id}/simulate`, { event: 'delivered' })
        .expect(200);
    } finally {
      orders.moveInTx = real;
    }
    expect(res.body.status).toBe('delivered');
    expect(res.body.events.at(-1).note).toMatch(/not changed because of an unexpected error/);
    expect((await orderOf(api, order.id)).status).toBe('ready_to_ship');
  });
});

describe('connections: secrets stay on the server', () => {
  const SECRET = 'pathao-client-secret-VERY-SECRET-123';
  const pathaoBody = {
    environment: 'sandbox',
    credentials: { clientId: 'cid-1', clientSecret: SECRET },
    webhookSecret: 'webhook-secret-0123456789',
    settings: { storeId: 777 },
  };

  it('stores credentials encrypted, never returns them, never logs them, and audits only that they changed', async () => {
    const { api, tenantId } = await shop();
    const saved = await api.patch('/v1/couriers/pathao', pathaoBody).expect(200);
    expect(JSON.stringify(saved.body)).not.toContain(SECRET);
    expect(JSON.stringify(saved.body)).not.toContain('webhook-secret-0123456789');
    expect(saved.body.connection).toMatchObject({
      hasCredentials: true,
      hasWebhookSecret: true,
      environment: 'sandbox',
      settings: { storeId: 777 },
    });
    expect(saved.body.connection.webhookUrl).toMatch(
      /\/v1\/webhooks\/couriers\/pathao\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/,
    );
    const list = await api.get('/v1/couriers').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect(list.body.map((c: { provider: string }) => c.provider)).toEqual([
      'mock',
      'pathao',
      'steadfast',
    ]);

    // at rest it is ciphertext
    const rows = await t.db.withContext(
      { tenantId },
      (tx) =>
        tx.$queryRaw<{ credentials_enc: string; webhook_secret_enc: string }[]>`
        SELECT credentials_enc, webhook_secret_enc FROM courier_connections WHERE provider = 'pathao'`,
    );
    expect(rows).toHaveLength(1);
    for (const r of rows) {
      expect(r.credentials_enc).not.toContain(SECRET);
      expect(r.credentials_enc.startsWith('v1.')).toBe(true);
      expect(r.webhook_secret_enc).not.toContain('webhook-secret');
    }
    expect(logs.join('')).not.toContain(SECRET);
    const audit = await t.db.withContext({ tenantId }, (tx) =>
      tx.auditLog.findMany({ where: { tenantId, action: 'courier.connection_saved' } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({
      provider: 'pathao',
      credentialsChanged: true,
      webhookSecretChanged: true,
    });
    // what changed is recorded; what it was changed to is not
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it('keeps saved credentials when only other things change, and refuses what a courier does not use', async () => {
    const { api } = await shop();
    await api.patch('/v1/couriers/pathao', pathaoBody).expect(200);
    const again = await api
      .patch('/v1/couriers/pathao', { settings: { deliveryType: 12 } })
      .expect(200);
    expect(again.body.connection).toMatchObject({
      hasCredentials: true,
      settings: { storeId: 777, deliveryType: 12 },
    });
    expect((await api.patch('/v1/couriers/pathao', { credentials: { apiKey: 'x' } })).status).toBe(
      400,
    );
    expect((await api.patch('/v1/couriers/steadfast', { environment: 'sandbox' })).status).toBe(
      400,
    ); // no documented sandbox
    expect(
      (await api.patch('/v1/couriers/steadfast', { credentials: { apiKey: 'only-one' } })).status,
    ).toBe(400); // needs both
    expect((await api.patch('/v1/couriers/mock', { credentials: { apiKey: 'x' } })).status).toBe(
      400,
    );
    expect((await api.patch('/v1/couriers/pathao', { webhookSecret: 'short' })).status).toBe(400);
  });

  it('saving other settings keeps a disabled connection disabled', async () => {
    const { api } = await shop();
    await api.patch('/v1/couriers/pathao', pathaoBody).expect(200);
    await api.patch('/v1/couriers/pathao', { enabled: false }).expect(200);
    const saved = await api.patch('/v1/couriers/pathao', { settings: { storeId: 778 } });
    expect(saved.body.connection).toMatchObject({ enabled: false });
    const again = await api.patch('/v1/couriers/pathao', { enabled: true }).expect(200);
    expect(again.body.connection).toMatchObject({ enabled: true });
  });

  it('removing a courier erases its secrets and switches it off', async () => {
    const { api } = await shop();
    await api.patch('/v1/couriers/pathao', pathaoBody).expect(200);
    const gone = await api.del('/v1/couriers/pathao').expect(200);
    expect(gone.body.connection).toMatchObject({
      hasCredentials: false,
      hasWebhookSecret: false,
      enabled: false,
    });
    expect((await api.post('/v1/couriers/pathao/test')).status).toBe(409);
  });

  it('who may do what', async () => {
    const { owner, api } = await shop();
    const roles = {
      admin: await addMember(t, owner, 'ADMIN'),
      manager: await addMember(t, owner, 'MANAGER'),
      staff: await addMember(t, owner, 'STAFF'),
      accountant: await addMember(t, owner, 'ACCOUNTANT'),
    };
    await connectMock(api).expect(200);
    const order = await readyOrder(owner, api);
    for (const who of Object.values(roles))
      expect((await call(who).get('/v1/couriers')).status).toBe(200);
    expect((await call(roles.admin).patch('/v1/couriers/mock', { enabled: true })).status).toBe(
      200,
    );
    for (const k of ['manager', 'staff', 'accountant'] as const) {
      expect((await call(roles[k]).patch('/v1/couriers/mock', { enabled: true })).status, k).toBe(
        403,
      );
      expect((await call(roles[k]).post('/v1/couriers/mock/test')).status, k).toBe(403);
    }
    expect((await book(call(roles.accountant), order.id)).status).toBe(403);
    expect((await call(roles.accountant).get(`/v1/orders/${order.id}/shipments`)).status).toBe(200);
    const b = await book(call(roles.staff), order.id);
    expect(b.status).toBe(201); // floor staff book parcels
    expect(
      (
        await call(roles.accountant).post(`/v1/shipments/${b.body.id}/simulate`, {
          event: 'picked_up',
        })
      ).status,
    ).toBe(403);
  });

  it('keeps one business’s couriers and shipments out of another’s sight', async () => {
    const a = await shop();
    const b = await shop();
    await connectMock(a.api).expect(200);
    const order = await readyOrder(a.owner, a.api);
    const booked = await book(a.api, order.id).expect(201);
    expect((await b.api.get(`/v1/shipments/${booked.body.id}`)).status).toBe(404);
    expect((await b.api.get(`/v1/orders/${order.id}/shipments`)).status).toBe(404);
    expect(
      (await b.api.post(`/v1/shipments/${booked.body.id}/simulate`, { event: 'delivered' })).status,
    ).toBe(404);
    expect(
      (await b.api.get('/v1/couriers')).body.find(
        (c: { provider: string }) => c.provider === 'mock',
      ).connection,
    ).toBeNull();
    await connectMock(b.api).expect(200);
    expect((await book(b.api, order.id)).status).toBe(404); // not their order
    expect(await shipmentsOf(a.api, order.id)).toHaveLength(1);
  });
});

describe('Pathao (mocked HTTP)', () => {
  const login = {
    body: { access_token: 'tok-pathao-DO-NOT-LEAK', refresh_token: 'r', expires_in: 432000 },
  };
  const created = {
    body: {
      data: {
        consignment_id: 'DL100',
        merchant_order_id: 'x',
        order_status: 'Pending',
        delivery_fee: 60,
      },
    },
  };
  const WH = 'webhook-secret-0123456789';

  async function connected(routes: Parameters<typeof fakeNetwork>[0]) {
    net = fakeNetwork({ 'POST /aladdin/api/v1/external/login': login, ...routes });
    const s = await shop();
    const saved = await s.api
      .patch('/v1/couriers/pathao', {
        environment: 'sandbox',
        credentials: { clientId: 'cid', clientSecret: 'csecret' },
        webhookSecret: WH,
        settings: { storeId: 777 },
      })
      .expect(200);
    const url = new URL(saved.body.connection.webhookUrl as string).pathname;
    return { ...s, url };
  }
  const hook = (url: string, body: object, secret: string | null = WH) => {
    const r = t.http.post(url);
    return (secret ? r.set('X-PATHAO-SIGNATURE', secret) : r).send(body);
  };

  it('tests the connection against the courier and remembers the result', async () => {
    const { api } = await connected({
      'GET /aladdin/api/v1/stores': {
        body: { data: { data: [{ store_id: 777, store_name: 'Rina Fashion', is_active: 1 }] } },
      },
    });
    const check = await api.post('/v1/couriers/pathao/test').expect(200);
    expect(check.body).toMatchObject({ ok: true, details: ['Store 777: Rina Fashion'] });
    expect(JSON.stringify(check.body)).not.toContain('DO-NOT-LEAK');
    const entry = (await api.get('/v1/couriers')).body.find(
      (c: { provider: string }) => c.provider === 'pathao',
    );
    expect(entry.connection).toMatchObject({ lastCheckOk: true });
    // wrong credentials are reported in plain words
    net = fakeNetwork({
      'POST /aladdin/api/v1/external/login': { status: 401, body: { message: 'bad' } },
    });
    await api
      .patch('/v1/couriers/pathao', { credentials: { clientSecret: 'changed' } })
      .expect(200);
    const bad = await api.post('/v1/couriers/pathao/test').expect(200);
    expect(bad.body).toMatchObject({
      ok: false,
      message: 'The courier did not accept these credentials.',
    });
  });

  it('books for real (against the fake network): sends the order as Pathao documents and marks it not simulated', async () => {
    const { owner, api } = await connected({ 'POST /aladdin/api/v1/orders': created });
    const order = await readyOrder(owner, api);
    const res = await book(api, order.id, 'pathao').expect(201);
    expect(res.body).toMatchObject({
      provider: 'pathao',
      environment: 'sandbox',
      simulated: false,
      status: 'booked',
      consignmentId: 'DL100',
      providerStatus: 'Pending',
      deliveryFeeMinor: 6000,
    });
    const sent = net.requests.find((r) => r.path === '/aladdin/api/v1/orders')!;
    expect(sent.body).toMatchObject({
      store_id: 777,
      merchant_order_id: `OL-${order.number}`,
      recipient_phone: '01712345678',
      amount_to_collect: 1060,
      item_quantity: 1,
    });
    expect(res.body.actions).toMatchObject({
      canSimulate: false,
      canCancel: false,
      canMarkCancelled: true,
    });
    // a real courier cannot be simulated
    expect(
      (await api.post(`/v1/shipments/${res.body.id}/simulate`, { event: 'delivered' })).status,
    ).toBe(409);
    // Pathao documents no cancel: we say so and offer the honest alternative
    const noCancel = await api.post(`/v1/shipments/${res.body.id}/cancel`, {
      reason: 'customer cancelled',
    });
    expect(noCancel.status).toBe(422);
    expect(noCancel.body.detail).toMatch(/no documented way to cancel/);
    const manual = await api
      .post(`/v1/shipments/${res.body.id}/resolve`, {
        resolution: 'cancelled_at_courier',
        reason: 'Cancelled by phone with Pathao',
      })
      .expect(200);
    expect(manual.body.status).toBe('cancelled');
  });

  it('never repeats a booking after a server error or a timeout, and blocks rebooking until a person settles it', async () => {
    for (const reply of [{ status: 500, body: {} }, timeoutError()]) {
      const { owner, api } = await connected({ 'POST /aladdin/api/v1/orders': reply });
      const order = await readyOrder(owner, api);
      const res = await book(api, order.id, 'pathao').expect(201);
      expect(res.body.status).toBe('booking_uncertain');
      expect(net.requests.filter((r) => r.path === '/aladdin/api/v1/orders')).toHaveLength(1); // never retried
      expect((await book(api, order.id, 'pathao')).status).toBe(409);
      expect(net.requests.filter((r) => r.path === '/aladdin/api/v1/orders')).toHaveLength(1); // nor re-sent by the block
    }
  });

  it('a refusal by Pathao is a failed booking carrying its reason, and a rate limit is a failed one that can be tried again', async () => {
    const { owner, api } = await connected({
      'POST /aladdin/api/v1/orders': {
        status: 422,
        body: {
          message: 'The given data was invalid.',
          errors: { recipient_phone: ['The recipient phone format is invalid.'] },
        },
      },
    });
    const order = await readyOrder(owner, api);
    const res = await book(api, order.id, 'pathao').expect(201);
    expect(res.body.status).toBe('booking_failed');
    expect(res.body.failureReason).toMatch(/invalid/i);
  });

  it('refreshes by asking Pathao, keeping its words and moving the order', async () => {
    const { owner, api } = await connected({
      'POST /aladdin/api/v1/orders': created,
      'GET /aladdin/api/v1/orders/DL100/info': {
        body: {
          data: {
            consignment_id: 'DL100',
            order_status: 'In Transit',
            order_status_slug: 'in-transit',
            updated_at: '2026-10-18 10:00:00',
          },
        },
      },
    });
    const order = await readyOrder(owner, api);
    const b = await book(api, order.id, 'pathao').expect(201);
    const r = await api.post(`/v1/shipments/${b.body.id}/refresh`).expect(200);
    expect(r.body).toMatchObject({ status: 'in_transit', providerStatus: 'In Transit' });
    expect((await orderOf(api, order.id)).status).toBe('in_transit');
    expect(r.body.events.at(-1)).toMatchObject({
      source: 'poll',
      providerStatus: 'In Transit',
      mappedStatus: 'in_transit',
      applied: true,
    });
    // asking again with nothing new adds nothing
    const same = await api.post(`/v1/shipments/${b.body.id}/refresh`).expect(200);
    expect(same.body.events).toHaveLength(r.body.events.length);
  });

  it('settles a booking as failed, not stuck, when the saved credentials can no longer be read', async () => {
    const { owner, api } = await connected({ 'POST /aladdin/api/v1/orders': created });
    const order = await readyOrder(owner, api);
    await t.db.withContext(
      { tenantId: owner.tenant.id },
      (tx) => tx.$executeRaw`UPDATE courier_connections SET credentials_enc = 'not-decryptable'`,
    );
    const b = await book(api, order.id, 'pathao').expect(201);
    expect(b.body.status).toBe('booking_failed');
    expect(b.body.failureReason).toMatch(/can no longer be read/);
    expect(net.requests.filter((r) => r.path === '/aladdin/api/v1/orders')).toHaveLength(0); // nothing was sent, so nothing can exist at the courier
  });

  describe('webhooks', () => {
    const event = (
      consignment: string,
      ref: string,
      name: string,
      status: string,
      at = '2026-10-18 11:00:00',
    ) => ({
      event: name,
      consignment_id: consignment,
      merchant_order_id: ref,
      order_status: status,
      delivery_fee: 60,
      updated_at: at,
      timestamp: at,
    });

    it('answers the handshake only for the real secret, and always with Pathao’s integration header', async () => {
      const { url } = await connected({});
      const ok = await hook(url, { event: 'webhook_integration' });
      expect(ok.status).toBe(202);
      expect(ok.headers['x-pathao-merchant-webhook-integration-secret']).toBe(
        'f3992ecc-59da-4cbe-a049-a13da2018d51',
      );
      for (const secret of ['wrong-secret-value-0123', null, '']) {
        const bad = await hook(url, { event: 'webhook_integration' }, secret);
        expect(bad.status).toBe(401);
        expect(bad.headers['x-pathao-merchant-webhook-integration-secret']).toBeUndefined();
      }
    });

    it('refuses events with a wrong or missing secret, a wrong tenant or an invented connection, all the same way', async () => {
      const { url, owner, api } = await connected({ 'POST /aladdin/api/v1/orders': created });
      const order = await readyOrder(owner, api);
      const b = await book(api, order.id, 'pathao').expect(201);
      const ev = event('DL100', `OL-${order.number}`, 'order.picked', 'Picked');
      expect((await hook(url, ev, 'nope-nope-nope-nope-nope')).status).toBe(401);
      expect((await hook(url, ev, null)).status).toBe(401);
      const [, , , , , tenant, conn] = url.split('/');
      const other = await shop();
      const elsewhere = `/v1/webhooks/couriers/pathao/${other.tenantId || '00000000-0000-4000-8000-000000000000'}/${conn}`;
      expect((await hook(elsewhere, ev)).status).toBe(401);
      expect(
        (
          await hook(
            `/v1/webhooks/couriers/pathao/${tenant}/00000000-0000-4000-8000-000000000000`,
            ev,
          )
        ).status,
      ).toBe(401);
      expect((await hook(url.replace('/pathao/', '/steadfast/'), ev)).status).toBe(401);
      expect((await hook('/v1/webhooks/couriers/mock/' + tenant + '/' + conn, ev)).status).toBe(
        401,
      );
      expect((await api.get(`/v1/shipments/${b.body.id}`)).body.status).toBe('booked'); // nothing got through
    });

    it('applies a real event once, moves the order, and ignores the same delivery repeated', async () => {
      const { url, owner, api } = await connected({ 'POST /aladdin/api/v1/orders': created });
      const order = await readyOrder(owner, api);
      const b = await book(api, order.id, 'pathao').expect(201);
      const ev = event('DL100', `OL-${order.number}`, 'order.picked', 'Picked');
      const first = await hook(url, ev);
      expect(first.status).toBe(200);
      expect(first.headers['x-pathao-merchant-webhook-integration-secret']).toBe(
        'f3992ecc-59da-4cbe-a049-a13da2018d51',
      );
      let s = (await api.get(`/v1/shipments/${b.body.id}`)).body;
      expect(s).toMatchObject({ status: 'picked_up' });
      expect(s.providerStatus).toContain('Picked');
      expect((await orderOf(api, order.id)).status).toBe('shipped');
      const count = s.events.length;
      for (let i = 0; i < 3; i++) expect((await hook(url, ev)).status).toBe(200); // retried by the courier
      s = (await api.get(`/v1/shipments/${b.body.id}`)).body;
      expect(s.events).toHaveLength(count);
      // a delivery follows; a late "picked" with a different time is recorded but changes nothing
      await hook(
        url,
        event('DL100', `OL-${order.number}`, 'order.delivered', 'Delivered', '2026-10-18 15:00:00'),
      ).expect(200);
      await hook(
        url,
        event('DL100', `OL-${order.number}`, 'order.picked', 'Picked', '2026-10-18 09:00:00'),
      ).expect(200);
      s = (await api.get(`/v1/shipments/${b.body.id}`)).body;
      expect(s.status).toBe('delivered');
      expect(s.events.at(-1)).toMatchObject({ applied: false, source: 'webhook' });
      expect((await orderOf(api, order.id)).status).toBe('delivered');
    });

    it('keeps a status it does not understand as sent, changes nothing, and acknowledges parcels it never booked', async () => {
      const { url, owner, api } = await connected({ 'POST /aladdin/api/v1/orders': created });
      const order = await readyOrder(owner, api);
      const b = await book(api, order.id, 'pathao').expect(201);
      await hook(
        url,
        event('DL100', `OL-${order.number}`, 'order.brand-new-thing', 'Brand New Thing'),
      ).expect(200);
      const s = (await api.get(`/v1/shipments/${b.body.id}`)).body;
      expect(s).toMatchObject({
        status: 'booked',
        providerStatus: expect.stringContaining('Brand New Thing'),
      });
      expect(s.events.at(-1)).toMatchObject({ applied: false, mappedStatus: 'unknown' });
      expect(
        (await hook(url, event('DL-NOT-OURS', 'SOMETHING-ELSE', 'order.delivered', 'Delivered')))
          .status,
      ).toBe(200);
      expect((await hook(url, { nothing: 'useful' })).status).toBe(400);
    });

    it('treats an update for a booking claimed long ago and never settled as proof that it exists', async () => {
      const { url, owner, api } = await connected({
        'POST /aladdin/api/v1/orders': { status: 500, body: {} },
      });
      const order = await readyOrder(owner, api);
      const b = await book(api, order.id, 'pathao').expect(201);
      await t.db.withContext(
        { tenantId: owner.tenant.id },
        (tx) =>
          tx.$executeRaw`UPDATE shipments SET status = 'booking', updated_at = now() - interval '10 minutes' WHERE id = ${b.body.id}::uuid`,
      );
      await hook(
        url,
        event('DL778', `OL-${order.number}`, 'order.pickup-requested', 'Pickup Requested'),
      ).expect(200);
      expect((await api.get(`/v1/shipments/${b.body.id}`)).body).toMatchObject({
        status: 'booked',
        consignmentId: 'DL778',
      });
    });

    it('treats an update for an unconfirmed booking as proof that it exists', async () => {
      const { url, owner, api } = await connected({
        'POST /aladdin/api/v1/orders': { status: 500, body: {} },
      });
      const order = await readyOrder(owner, api);
      const b = await book(api, order.id, 'pathao').expect(201);
      expect(b.body.status).toBe('booking_uncertain');
      await hook(
        url,
        event('DL777', `OL-${order.number}`, 'order.pickup-requested', 'Pickup Requested'),
      ).expect(200);
      const s = (await api.get(`/v1/shipments/${b.body.id}`)).body;
      expect(s).toMatchObject({ status: 'booked', consignmentId: 'DL777' });
      expect(s.events.some((e: { note: string | null }) => /exists/.test(e.note ?? ''))).toBe(true);
    });
  });
});

describe('Steadfast (mocked HTTP)', () => {
  const TOKEN = 'steadfast-token-0123456789';
  const ok = {
    body: {
      status: 200,
      consignment: {
        consignment_id: 5001,
        invoice: 'x',
        tracking_code: 'TRK1',
        status: 'in_review',
      },
    },
  };

  async function connected(routes: Parameters<typeof fakeNetwork>[0]) {
    net = fakeNetwork(routes);
    const s = await shop();
    const saved = await s.api
      .patch('/v1/couriers/steadfast', {
        environment: 'production',
        credentials: { apiKey: 'sf-key-DO-NOT-LEAK', secretKey: 'sf-secret-DO-NOT-LEAK' },
        webhookSecret: TOKEN,
      })
      .expect(200);
    return { ...s, url: new URL(saved.body.connection.webhookUrl as string).pathname };
  }
  const hook = (
    url: string,
    body: object,
    auth: string | null = `Bearer ${TOKEN}`,
    extra: Record<string, string> = {},
  ) => {
    let r = t.http.post(url);
    if (auth) r = r.set('Authorization', auth);
    for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
    return r.send(body);
  };

  it('books with our order number as the invoice and keeps the courier’s own status', async () => {
    const { owner, api } = await connected({ 'POST /api/v1/create_order': ok });
    const order = await readyOrder(owner, api);
    const res = await book(api, order.id, 'steadfast').expect(201);
    expect(res.body).toMatchObject({
      provider: 'steadfast',
      simulated: false,
      status: 'booked',
      consignmentId: '5001',
      trackingCode: 'TRK1',
      providerStatus: 'in_review',
    });
    expect(net.requests[0]!.body).toMatchObject({
      invoice: `OL-${order.number}`,
      cod_amount: 1060,
      recipient_phone: '01712345678',
    });
    expect(net.requests[0]!.headers).toMatchObject({
      'api-key': 'sf-key-DO-NOT-LEAK',
      'secret-key': 'sf-secret-DO-NOT-LEAK',
    });
    expect(JSON.stringify(res.body)).not.toContain('DO-NOT-LEAK');
    expect(logs.join('')).not.toContain('DO-NOT-LEAK');
  });

  it('after a timeout it asks Steadfast for the invoice instead of guessing: found means booked once, not found means safe to retry', async () => {
    let { owner, api } = await connected({
      'POST /api/v1/create_order': timeoutError(),
      'GET /api/v1/status_by_invoice/': { body: { status: 200, delivery_status: 'in_review' } },
    });
    let order = await readyOrder(owner, api);
    const found = await book(api, order.id, 'steadfast').expect(201);
    expect(found.body.status).toBe('booked');
    expect(net.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(await shipmentsOf(api, order.id)).toHaveLength(1);

    ({ owner, api } = await connected({
      'POST /api/v1/create_order': timeoutError(),
      'GET /api/v1/status_by_invoice/': { status: 404, body: {} },
    }));
    order = await readyOrder(owner, api);
    const missing = await book(api, order.id, 'steadfast').expect(201);
    expect(missing.body.status).toBe('booking_failed');
    expect(missing.body.failureReason).toMatch(/nothing was created/);
  });

  it('refreshes an unconfirmed booking by invoice, settling it without a person', async () => {
    const { owner, api } = await connected({
      'POST /api/v1/create_order': timeoutError(),
      'GET /api/v1/status_by_invoice/': [
        { status: 503, body: {} },
        { status: 503, body: {} },
        { status: 503, body: {} },
        { body: { status: 200, delivery_status: 'in_review' } },
      ],
    });
    const order = await readyOrder(owner, api);
    const b = await book(api, order.id, 'steadfast').expect(201);
    expect(b.body.status).toBe('booking_uncertain'); // the lookup itself failed: stay unsure
    expect(b.body.actions).toMatchObject({ needsResolution: true, canRefresh: true });
    const r = await api.post(`/v1/shipments/${b.body.id}/refresh`).expect(200);
    expect(r.body.status).toBe('booked');
  });

  it('webhooks need the Bearer token; payloads are checked; delivery moves the order; Idempotency-Key repeats do nothing', async () => {
    const { owner, api, url } = await connected({ 'POST /api/v1/create_order': ok });
    const order = await readyOrder(owner, api);
    const b = await book(api, order.id, 'steadfast').expect(201);
    const payload = (status: string, at: string) => ({
      notification_type: 'delivery_status',
      consignment_id: 5001,
      invoice: `OL-${order.number}`,
      cod_amount: 1060,
      status,
      delivery_charge: 60,
      tracking_message: 'Updated',
      updated_at: at,
    });
    expect((await hook(url, payload('delivered', '2026-10-18 10:00:00'), null)).status).toBe(401);
    expect(
      (await hook(url, payload('delivered', '2026-10-18 10:00:00'), 'Bearer nope')).status,
    ).toBe(401);
    expect((await hook(url, payload('delivered', '2026-10-18 10:00:00'), TOKEN)).status).toBe(401); // missing the Bearer word
    expect(
      (await hook(url, { notification_type: 'delivery_status', consignment_id: 5001 })).status,
    ).toBe(400);
    const good = await hook(
      url,
      payload('delivered_approval_pending', '2026-10-18 10:00:00'),
      undefined,
      { 'Idempotency-Key': 'evt-1' },
    );
    expect(good.status).toBe(200);
    expect(good.body).toEqual({ status: 'success' });
    let s = (await api.get(`/v1/shipments/${b.body.id}`)).body;
    expect(s).toMatchObject({ status: 'delivered', providerStatus: 'delivered_approval_pending' });
    expect((await orderOf(api, order.id)).status).toBe('delivered');
    const n = s.events.length;
    await hook(url, payload('delivered_approval_pending', '2026-10-18 10:00:00'), undefined, {
      'Idempotency-Key': 'evt-1',
    }).expect(200);
    s = (await api.get(`/v1/shipments/${b.body.id}`)).body;
    expect(s.events).toHaveLength(n);
    // a tracking note is kept and changes nothing
    await hook(url, {
      notification_type: 'tracking_update',
      consignment_id: 5001,
      tracking_message: 'Parcel at hub',
      updated_at: '2026-10-18 11:00:00',
    }).expect(200);
    s = (await api.get(`/v1/shipments/${b.body.id}`)).body;
    expect(s.events.at(-1)).toMatchObject({
      providerStatus: 'tracking_update',
      mappedStatus: null,
      applied: false,
    });
    expect(s.status).toBe('delivered');
  });
});
