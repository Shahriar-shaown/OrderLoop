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
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

type Who = { accessToken: string };
let seq = 0;
const key = (p = 'ord') => `${p}-${Date.now()}-${++seq}`;
const phoneOf = (n: number) => `0171${String(1000000 + n).slice(-7)}`;
let phoneSeq = 100;
const newPhone = () => phoneOf(++phoneSeq);

const call = (who: Who) => ({
  get: (path: string) => t.http.get(path).set(bearer(who.accessToken)),
  post: (path: string, body: object = {}) =>
    t.http.post(path).set(bearer(who.accessToken)).send(body),
  patch: (path: string, body: object) => t.http.patch(path).set(bearer(who.accessToken)).send(body),
  del: (path: string) => t.http.delete(path).set(bearer(who.accessToken)),
});

/** A fresh business with its own owner. */
const shop = async () => {
  const owner = await registerTenant(t);
  return { owner, api: call(owner) };
};

/** A product with one variant and `stock` units on the shelf. */
async function item(owner: Who, stock: number, opts: { priceMinor?: number; sku?: string } = {}) {
  const { variant } = await createProduct(t, owner.accessToken, {
    priceMinor: opts.priceMinor ?? 100_000,
    ...(opts.sku ? { sku: opts.sku } : {}),
  });
  if (stock > 0)
    await call(owner)
      .post('/v1/inventory/receive', { variantId: variant.id, quantity: stock })
      .expect(201);
  return variant as { id: string; sku: string };
}

const address = (extra: object = {}) => ({
  recipientName: 'Rina Akter',
  phone: '01712345678',
  line1: 'House 5, Road 3, Dhanmondi',
  area: 'Dhanmondi',
  district: 'Dhaka',
  division: 'Dhaka',
  ...extra,
});

/** A valid create-order body; override any part. */
const body = (items: object[], extra: object = {}) => ({
  customer: { name: 'Rina Akter', phone: '01712345678' },
  address: address(),
  items,
  idempotencyKey: key(),
  ...extra,
});

const level = async (api: ReturnType<typeof call>, variantId: string) => {
  const rows = (await api.get(`/v1/inventory?variantId=${variantId}`)).body.items as {
    onHand: number;
    reserved: number;
    available: number;
    damaged: number;
  }[];
  return rows[0] ?? { onHand: 0, reserved: 0, available: 0, damaged: 0 };
};
const moves = async (api: ReturnType<typeof call>, variantId: string, type?: string) =>
  (await api.get(`/v1/inventory/movements?variantId=${variantId}${type ? `&type=${type}` : ''}`))
    .body.items as {
    type: string;
    referenceType: string | null;
    referenceId: string | null;
    idempotencyKey?: string;
  }[];
const status = (api: ReturnType<typeof call>, id: string, to: string, extra: object = {}) =>
  api.post(`/v1/orders/${id}/status`, { status: to, ...extra });
const walk = async (api: ReturnType<typeof call>, id: string, steps: string[]) => {
  for (const s of steps) await status(api, id, s).expect(200);
};

describe('creating an order: totals come from the server', () => {
  it('works out every figure from quantities and prices, and ignores totals a client sends', async () => {
    const { owner, api } = await shop();
    const tee = await item(owner, 10, { priceMinor: 125_050 }); // 1250.50
    const mug = await item(owner, 10, { priceMinor: 80_000 });
    // totals sent by a client are refused outright, and nothing is created
    for (const field of ['totalMinor', 'subtotalMinor', 'codAmountMinor', 'lineTotalMinor'])
      expect(
        (
          await api.post('/v1/orders', {
            ...body([{ variantId: tee.id, quantity: 1 }]),
            [field]: 1,
          })
        ).status,
      ).toBe(400);
    expect((await api.get('/v1/orders')).body.total).toBe(0);
    const res = await api
      .post('/v1/orders', {
        ...body(
          [
            { variantId: tee.id, quantity: 2 },
            { variantId: mug.id, quantity: 1, discountMinor: 5_000 },
          ],
          { discountMinor: 10_000, deliveryChargeMinor: 6_000, advancePaidMinor: 50_000 },
        ),
      })
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'pending_confirmation',
      subtotalMinor: 325_100, // 2 x 125050 + (80000 - 5000)
      discountMinor: 10_000,
      deliveryChargeMinor: 6_000,
      totalMinor: 321_100,
      advancePaidMinor: 50_000,
      codAmountMinor: 271_100,
      stockHeld: false,
    });
    expect(res.body.items.map((i: { lineTotalMinor: number }) => i.lineTotalMinor)).toEqual([
      250_100, 75_000,
    ]);
    expect(res.body.items[0]).toMatchObject({ sku: tee.sku, unitPriceMinor: 125_050, quantity: 2 });
  });

  it('uses the catalog price unless a price is given, and records the price it used', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5, { priceMinor: 100_000 });
    const res = await api
      .post('/v1/orders', body([{ variantId: v.id, quantity: 1, unitPriceMinor: 90_000 }]))
      .expect(201);
    expect(res.body.items[0].unitPriceMinor).toBe(90_000);
    // the catalog price changing later does not rewrite the order
    await api.patch(`/v1/variants/${v.id}`, { priceMinor: 999_999 }).expect(200);
    expect((await api.get(`/v1/orders/${res.body.id}`)).body.items[0].unitPriceMinor).toBe(90_000);
  });

  it('refuses figures that do not make sense, naming the field', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5, { priceMinor: 10_000 });
    const make = (items: object[], extra: object = {}) =>
      api.post('/v1/orders', body(items, extra));
    const paths = async (
      res:
        | Promise<{ status: number; body: { errors?: { path: string }[] } }>
        | { status: number; body: { errors?: { path: string }[] } },
    ) => {
      const r = await res;
      return { status: r.status, paths: (r.body.errors ?? []).map((e) => e.path) };
    };
    expect(
      await paths(make([{ variantId: v.id, quantity: 1 }], { discountMinor: 10_001 })),
    ).toEqual({ status: 400, paths: ['body.discountMinor'] });
    expect(
      await paths(make([{ variantId: v.id, quantity: 1 }], { advancePaidMinor: 10_001 })),
    ).toEqual({ status: 400, paths: ['body.advancePaidMinor'] });
    expect(await paths(make([{ variantId: v.id, quantity: 1, discountMinor: 10_001 }]))).toEqual({
      status: 400,
      paths: ['body.lines.0.discountMinor'],
    });
    expect((await make([{ variantId: v.id, quantity: 0 }])).status).toBe(400);
    expect((await make([{ variantId: v.id, quantity: 1.5 }])).status).toBe(400);
    expect((await make([{ variantId: v.id, quantity: 1, unitPriceMinor: 12.5 }])).status).toBe(400);
    expect((await make([])).status).toBe(400);
    expect(
      (
        await make([
          { variantId: v.id, quantity: 1 },
          { variantId: v.id, quantity: 2 },
        ])
      ).status,
    ).toBe(400); // twice
    expect(
      (await make([{ variantId: '0197b0a0-0000-7000-8000-00000000dead', quantity: 1 }])).status,
    ).toBe(400);
    expect(
      (await make([{ variantId: v.id, quantity: 1 }], { deliveryChargeMinor: -1 })).status,
    ).toBe(400);
  });

  it('refuses an archived item, a bad phone, and missing customer or address', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    await api.patch(`/v1/variants/${v.id}`, { archived: true }).expect(200);
    expect((await api.post('/v1/orders', body([{ variantId: v.id, quantity: 1 }]))).status).toBe(
      400,
    );
    const ok = await item(owner, 5);
    const items = [{ variantId: ok.id, quantity: 1 }];
    expect(
      (await api.post('/v1/orders', body(items, { customer: { name: 'Rina', phone: '12345' } })))
        .status,
    ).toBe(400);
    expect(
      (await api.post('/v1/orders', { items, idempotencyKey: key(), address: address() })).status,
    ).toBe(400);
    expect(
      (
        await api.post('/v1/orders', {
          items,
          idempotencyKey: key(),
          customer: { name: 'Rina', phone: '01712345678' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await api.post('/v1/orders', { ...body(items), idempotencyKey: undefined })).status,
    ).toBe(400);
  });

  it('numbers orders per business from 1001, with no gaps, and a failed order does not use a number', async () => {
    const a = await shop();
    const b = await shop();
    const va = await item(a.owner, 1);
    const vb = await item(b.owner, 5);
    const first = (
      await a.api.post('/v1/orders', body([{ variantId: va.id, quantity: 1 }])).expect(201)
    ).body;
    expect(first.orderNumber).toBe(1001);
    // fails (confirming more than exists): rolled back whole
    expect(
      (await a.api.post('/v1/orders', body([{ variantId: va.id, quantity: 5 }], { confirm: true })))
        .status,
    ).toBe(409);
    const second = (
      await a.api.post('/v1/orders', body([{ variantId: va.id, quantity: 1 }])).expect(201)
    ).body;
    expect(second.orderNumber).toBe(1002);
    // another business starts its own count
    expect(
      (await b.api.post('/v1/orders', body([{ variantId: vb.id, quantity: 1 }])).expect(201)).body
        .orderNumber,
    ).toBe(1001);
  });

  it('holds no stock until confirmed, and records its creation in the history', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 4);
    const o = (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 3 }])).expect(201))
      .body;
    expect(await level(api, v.id)).toMatchObject({ onHand: 4, reserved: 0, available: 4 });
    expect(o.history).toHaveLength(1);
    expect(o.history[0]).toMatchObject({
      fromStatus: null,
      toStatus: 'pending_confirmation',
      actorName: expect.any(String),
    });
    expect(o.allowedStatuses).toEqual(['confirmed', 'cancelled']);
  });

  it('matches the customer on phone number, however it is written, and saves the address once', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const first = (
      await api
        .post(
          '/v1/orders',
          body([{ variantId: v.id, quantity: 1 }], {
            customer: { name: 'Rina Akter', phone: '01712-345678' },
          }),
        )
        .expect(201)
    ).body;
    const second = (
      await api
        .post(
          '/v1/orders',
          body([{ variantId: v.id, quantity: 1 }], {
            customer: { name: 'R. Akter', phone: '+8801712345678' },
          }),
        )
        .expect(201)
    ).body;
    expect(second.customer.id).toBe(first.customer.id);
    expect(second.customer.name).toBe('Rina Akter'); // the existing customer is not renamed
    const customers = (await api.get('/v1/customers')).body.items as unknown[];
    expect(customers).toHaveLength(1);
    const detail = (await api.get(`/v1/customers/${first.customer.id}`)).body;
    expect(detail.addresses).toHaveLength(1);
    expect(detail.addresses[0].isDefault).toBe(true);
    expect(detail.stats.ordersCount).toBe(2);
  });

  it('uses a saved address and snapshots it, so editing the address book never rewrites an order', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const c = (
      await api.post('/v1/customers', { name: 'Karim Uddin', phone: '01812345678' }).expect(201)
    ).body;
    const a = (
      await api
        .post(
          `/v1/customers/${c.id}/addresses`,
          address({ recipientName: 'Karim Uddin', phone: '01812345678', line1: 'Old road' }),
        )
        .expect(201)
    ).body;
    const o = (
      await api
        .post('/v1/orders', {
          customerId: c.id,
          addressId: a.id,
          items: [{ variantId: v.id, quantity: 1 }],
          idempotencyKey: key(),
        })
        .expect(201)
    ).body;
    expect(o.shipping.line1).toBe('Old road');
    await api.patch(`/v1/customers/${c.id}/addresses/${a.id}`, { line1: 'New road' }).expect(200);
    expect((await api.get(`/v1/orders/${o.id}`)).body.shipping.line1).toBe('Old road');
  });
});

describe('creating an order twice by retrying', () => {
  it('returns the same order for the same key, and holds stock once', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const req = body([{ variantId: v.id, quantity: 4 }], { confirm: true });
    const a = await api.post('/v1/orders', req).expect(201);
    const b = await api.post('/v1/orders', req);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.orderNumber).toBe(a.body.orderNumber);
    expect((await api.get('/v1/orders')).body.total).toBe(1);
    expect(await level(api, v.id)).toMatchObject({ onHand: 10, reserved: 4 });
    expect(await moves(api, v.id, 'RESERVE')).toHaveLength(1);
  });

  it('twenty simultaneous requests with one key make exactly one order', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 50);
    const req = body([{ variantId: v.id, quantity: 2 }], { confirm: true });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => api.post('/v1/orders', req)),
    );
    for (const r of results) expect(r.status).toBe(201);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect((await api.get('/v1/orders')).body.total).toBe(1);
    expect(await level(api, v.id)).toMatchObject({ reserved: 2 });
  });

  it('refuses a key reused for a different order, without changing anything', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const first = body([{ variantId: v.id, quantity: 1 }]);
    await api.post('/v1/orders', first).expect(201);
    const other = await api.post('/v1/orders', {
      ...first,
      items: [{ variantId: v.id, quantity: 2 }],
    });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('idempotency_conflict');
    expect((await api.get('/v1/orders')).body.total).toBe(1);
  });

  it('keys are per business', async () => {
    const a = await shop();
    const b = await shop();
    const va = await item(a.owner, 5);
    const vb = await item(b.owner, 5);
    const shared = key('shared');
    await a.api
      .post('/v1/orders', body([{ variantId: va.id, quantity: 1 }], { idempotencyKey: shared }))
      .expect(201);
    const r = await b.api.post(
      '/v1/orders',
      body([{ variantId: vb.id, quantity: 1 }], { idempotencyKey: shared }),
    );
    expect(r.status).toBe(201);
    expect(r.body.items[0].variantId).toBe(vb.id);
  });
});

describe('the status machine', () => {
  it('walks the whole life of an order, moving stock at exactly the agreed moments', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const o = (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 3 }])).expect(201))
      .body;
    await status(api, o.id, 'confirmed').expect(200);
    expect(await level(api, v.id)).toMatchObject({ onHand: 10, reserved: 3, available: 7 }); // reserved on confirm
    await status(api, o.id, 'ready_to_ship').expect(200);
    expect(await level(api, v.id)).toMatchObject({ onHand: 10, reserved: 3 }); // still held
    await status(api, o.id, 'shipped').expect(200);
    expect(await level(api, v.id)).toMatchObject({ onHand: 7, reserved: 0, available: 7 }); // left on handover
    await status(api, o.id, 'in_transit').expect(200);
    const done = (await status(api, o.id, 'delivered').expect(200)).body;
    expect(await level(api, v.id)).toMatchObject({ onHand: 7, reserved: 0 }); // delivery moves nothing
    expect(done.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'pending_confirmation',
      'confirmed',
      'ready_to_ship',
      'shipped',
      'in_transit',
      'delivered',
    ]);
    expect(done.history[1]).toMatchObject({
      fromStatus: 'pending_confirmation',
      toStatus: 'confirmed',
    });
    expect(done.allowedStatuses).toEqual(['return_requested']);
    expect(done.stockHeld).toBe(false);
    const types = (await moves(api, v.id)).map((m) => m.type).sort();
    expect(types).toEqual(['RECEIVE', 'RESERVE', 'SHIP']);
  });

  it('refuses every move the machine does not allow, and changes nothing', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const make = async () =>
      (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 1 }])).expect(201)).body
        .id as string;
    const refused = async (id: string, to: string) => {
      const r = await status(api, id, to, { reason: 'because I said so' });
      expect(r.status, `-> ${to}`).toBe(409);
      expect(r.body.code).toBe('invalid_transition');
    };
    const pending = await make();
    for (const to of [
      'ready_to_ship',
      'shipped',
      'in_transit',
      'delivered',
      'delivery_failed',
      'return_requested',
      'returned',
    ])
      await refused(pending, to);
    const confirmed = await make();
    await walk(api, confirmed, ['confirmed']);
    for (const to of ['shipped', 'delivered', 'return_requested']) await refused(confirmed, to);
    const shipped = await make();
    await walk(api, shipped, ['confirmed', 'ready_to_ship', 'shipped']);
    for (const to of ['cancelled', 'confirmed', 'ready_to_ship']) await refused(shipped, to); // the goods have left
    const cancelled = await make();
    await status(api, cancelled, 'cancelled', { reason: 'customer changed mind' }).expect(200);
    for (const to of ['confirmed', 'pending_confirmation', 'shipped', 'returned'])
      await refused(cancelled, to);
    expect((await api.get(`/v1/orders/${cancelled}`)).body.status).toBe('cancelled');
    expect((await api.get(`/v1/orders/${shipped}`)).body.status).toBe('shipped');
  });

  it('asks for a reason where one is needed, and keeps it in the history', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const id = (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 1 }])).expect(201))
      .body.id as string;
    const noReason = await status(api, id, 'cancelled');
    expect(noReason.status).toBe(400);
    expect(noReason.body.errors[0].path).toBe('body.reason');
    expect((await status(api, id, 'cancelled', { reason: 'ok' })).status).toBe(400); // too short
    const done = (
      await status(api, id, 'cancelled', { reason: 'Customer did not answer the call' }).expect(200)
    ).body;
    expect(done.history.at(-1)).toMatchObject({
      toStatus: 'cancelled',
      reason: 'Customer did not answer the call',
    });
  });

  it('repeating a status change is harmless: no second history row, no second stock movement', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const id = (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 2 }])).expect(201))
      .body.id as string;
    await status(api, id, 'confirmed').expect(200);
    const again = await status(api, id, 'confirmed').expect(200);
    expect(
      again.body.history.filter((h: { toStatus: string }) => h.toStatus === 'confirmed'),
    ).toHaveLength(1);
    expect(await moves(api, v.id, 'RESERVE')).toHaveLength(1);
    expect(await level(api, v.id)).toMatchObject({ reserved: 2 });
  });

  it('delivery can fail and be retried, or turn into a return', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const id = (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 1 }])).expect(201))
      .body.id as string;
    await walk(api, id, ['confirmed', 'ready_to_ship', 'shipped', 'in_transit']);
    await status(api, id, 'delivery_failed', { reason: 'Customer not at home' }).expect(200);
    await status(api, id, 'in_transit').expect(200); // retried
    await status(api, id, 'delivery_failed', { reason: 'Refused at the door' }).expect(200);
    await status(api, id, 'return_requested', { reason: 'Courier bringing it back' }).expect(200);
    await status(api, id, 'delivered').expect(200); // the return was declined
    await status(api, id, 'return_requested', { reason: 'Customer sent it back' }).expect(200);
    const r = (
      await status(api, id, 'returned', { reason: 'Received at the warehouse' }).expect(200)
    ).body;
    expect(r.allowedStatuses).toEqual([]);
  });

  it('a version that is out of date is refused rather than overwriting', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const o = (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 1 }])).expect(201))
      .body;
    await api.patch(`/v1/orders/${o.id}`, { notes: 'first edit' }).expect(200);
    const stale = await api.patch(`/v1/orders/${o.id}`, {
      notes: 'second edit',
      ifVersion: o.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect((await status(api, o.id, 'confirmed', { ifVersion: o.version })).status).toBe(409);
  });
});

describe('stock reservation', () => {
  it('reserves every line or none, and names every item that is short', async () => {
    const { owner, api } = await shop();
    const plenty = await item(owner, 10);
    const scarce1 = await item(owner, 1);
    const scarce2 = await item(owner, 2);
    const o = (
      await api
        .post(
          '/v1/orders',
          body([
            { variantId: plenty.id, quantity: 5 },
            { variantId: scarce1.id, quantity: 3 },
            { variantId: scarce2.id, quantity: 4 },
          ]),
        )
        .expect(201)
    ).body;
    const r = await status(api, o.id, 'confirmed');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('insufficient_stock');
    expect(r.body.detail).toContain(scarce1.sku);
    expect(r.body.detail).toContain(scarce2.sku);
    expect(r.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([
      'items.1',
      'items.2',
    ]);
    // nothing was held, not even the line that could have been
    for (const v of [plenty, scarce1, scarce2]) expect((await level(api, v.id)).reserved).toBe(0);
    expect((await api.get(`/v1/orders/${o.id}`)).body.status).toBe('pending_confirmation');
    // once stock arrives it confirms
    await api.post('/v1/inventory/receive', { variantId: scarce1.id, quantity: 5 }).expect(201);
    await api.post('/v1/inventory/receive', { variantId: scarce2.id, quantity: 5 }).expect(201);
    await status(api, o.id, 'confirmed').expect(200);
    expect((await level(api, scarce1.id)).reserved).toBe(3);
  });

  it('confirming at creation is one transaction: short stock means no order at all', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 2);
    const r = await api.post(
      '/v1/orders',
      body([{ variantId: v.id, quantity: 3 }], { confirm: true }),
    );
    expect(r.status).toBe(409);
    expect((await api.get('/v1/orders')).body.total).toBe(0);
    expect((await api.get('/v1/customers')).body.items).toHaveLength(0); // the customer was not created either
    expect(await moves(api, v.id, 'RESERVE')).toHaveLength(0);
  });

  it('two orders confirming at once for the last unit: exactly one gets it', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 1);
    const ids = await Promise.all(
      [0, 1].map(
        async () =>
          (
            await api
              .post(
                '/v1/orders',
                body([{ variantId: v.id, quantity: 1 }], {
                  customer: { name: 'Buyer', phone: newPhone() },
                }),
              )
              .expect(201)
          ).body.id as string,
      ),
    );
    const results = await Promise.all(ids.map((id) => status(api, id, 'confirmed')));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('insufficient_stock');
    expect(await level(api, v.id)).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
  });

  it('thirty orders racing for ten units: exactly ten are confirmed, and the books balance', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const ids = await Promise.all(
      Array.from(
        { length: 30 },
        async (_, i) =>
          (
            await api
              .post(
                '/v1/orders',
                body([{ variantId: v.id, quantity: 1 }], {
                  customer: { name: `Buyer ${i}`, phone: newPhone() },
                }),
              )
              .expect(201)
          ).body.id as string,
      ),
    );
    const results = await Promise.all(ids.map((id) => status(api, id, 'confirmed')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    expect(results.filter((r) => r.status === 409)).toHaveLength(20);
    for (const r of results.filter((x) => x.status === 409))
      expect(r.body.code).toBe('insufficient_stock');
    expect(await level(api, v.id)).toMatchObject({ onHand: 10, reserved: 10, available: 0 });
    const confirmed = (await api.get('/v1/orders?status=confirmed&limit=100')).body.total;
    expect(confirmed).toBe(10);
    // every reserved unit belongs to a confirmed order
    const reservations = (await api.get('/v1/reservations?status=ACTIVE&limit=100')).body.items as {
      referenceType: string;
    }[];
    expect(reservations).toHaveLength(10);
    for (const r of reservations) expect(r.referenceType).toBe('order');
  });

  it('refuses to reserve a variant archived after the order was made', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const o = (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 1 }])).expect(201))
      .body;
    await api.patch(`/v1/variants/${v.id}`, { archived: true }).expect(200);
    expect((await status(api, o.id, 'confirmed')).status).toBe(409);
  });
});

describe('cancellation', () => {
  it('releases held stock once; cancelling again, or at the same moment, changes nothing more', async () => {
    const { owner, api } = await shop();
    const a = await item(owner, 10);
    const b = await item(owner, 10);
    const o = (
      await api
        .post(
          '/v1/orders',
          body(
            [
              { variantId: a.id, quantity: 3 },
              { variantId: b.id, quantity: 2 },
            ],
            { confirm: true },
          ),
        )
        .expect(201)
    ).body;
    expect(await level(api, a.id)).toMatchObject({ reserved: 3, available: 7 });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        status(api, o.id, 'cancelled', { reason: 'Customer cancelled' }),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);
    expect(await level(api, a.id)).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
    expect(await level(api, b.id)).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
    expect(await moves(api, a.id, 'RELEASE')).toHaveLength(1);
    expect(await moves(api, b.id, 'RELEASE')).toHaveLength(1);
    const detail = (await api.get(`/v1/orders/${o.id}`)).body;
    expect(
      detail.history.filter((h: { toStatus: string }) => h.toStatus === 'cancelled'),
    ).toHaveLength(1);
    expect(detail.stockHeld).toBe(false);
    await status(api, o.id, 'cancelled', { reason: 'Customer cancelled' }).expect(200); // still fine, still one release
    expect(await moves(api, a.id, 'RELEASE')).toHaveLength(1);
  });

  it('cancelling an unconfirmed order touches no stock', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const o = (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 2 }])).expect(201))
      .body;
    await status(api, o.id, 'cancelled', { reason: 'Duplicate of another order' }).expect(200);
    expect(await moves(api, v.id)).toHaveLength(1); // only the RECEIVE
    expect(await level(api, v.id)).toMatchObject({ onHand: 5, reserved: 0 });
  });

  it('cancelling a ready-to-ship order releases it; a cancelled order can be neither confirmed nor shipped', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const o = (
      await api
        .post('/v1/orders', body([{ variantId: v.id, quantity: 5 }], { confirm: true }))
        .expect(201)
    ).body;
    await status(api, o.id, 'ready_to_ship').expect(200);
    await status(api, o.id, 'cancelled', { reason: 'Courier unavailable' }).expect(200);
    expect(await level(api, v.id)).toMatchObject({ onHand: 5, reserved: 0, available: 5 });
    expect((await status(api, o.id, 'confirmed')).status).toBe(409);
    expect((await status(api, o.id, 'shipped')).status).toBe(409);
    // the freed stock is immediately available to another order
    const next = (
      await api.post(
        '/v1/orders',
        body([{ variantId: v.id, quantity: 5 }], {
          confirm: true,
          customer: { name: 'Next', phone: newPhone() },
        }),
      )
    ).status;
    expect(next).toBe(201);
  });

  it('a shipped order cannot be cancelled: the goods have left', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const o = (
      await api
        .post('/v1/orders', body([{ variantId: v.id, quantity: 1 }], { confirm: true }))
        .expect(201)
    ).body;
    await walk(api, o.id, ['ready_to_ship', 'shipped']);
    expect((await status(api, o.id, 'cancelled', { reason: 'Changed my mind' })).status).toBe(409);
    expect(await level(api, v.id)).toMatchObject({ onHand: 4, reserved: 0 });
  });
});

describe('returns', () => {
  const delivered = async (api: ReturnType<typeof call>, v: { id: string }, qty: number) => {
    const o = (
      await api
        .post('/v1/orders', body([{ variantId: v.id, quantity: qty }], { confirm: true }))
        .expect(201)
    ).body;
    await walk(api, o.id, ['ready_to_ship', 'shipped', 'in_transit', 'delivered']);
    return o as { id: string; items: { id: string }[] };
  };

  it('puts returned goods back on the shelf, once, however many times it is processed', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const o = await delivered(api, v, 4);
    expect(await level(api, v.id)).toMatchObject({ onHand: 6 });
    await status(api, o.id, 'return_requested', { reason: 'Wrong size' }).expect(200);
    expect(await level(api, v.id)).toMatchObject({ onHand: 6 }); // asking for a return moves nothing
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        status(api, o.id, 'returned', { reason: 'Back at the warehouse' }),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);
    expect(await level(api, v.id)).toMatchObject({
      onHand: 10,
      reserved: 0,
      damaged: 0,
      available: 10,
    });
    const returns = await moves(api, v.id, 'RETURN');
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({ referenceType: 'order', referenceId: o.id });
    await status(api, o.id, 'returned', { reason: 'Back at the warehouse' }).expect(200); // and again later
    expect(await level(api, v.id)).toMatchObject({ onHand: 10 });
  });

  it('sends damaged returns to the damaged bucket, line by line', async () => {
    const { owner, api } = await shop();
    const good = await item(owner, 10);
    const broken = await item(owner, 10);
    const o = (
      await api
        .post(
          '/v1/orders',
          body(
            [
              { variantId: good.id, quantity: 2 },
              { variantId: broken.id, quantity: 3 },
            ],
            { confirm: true },
          ),
        )
        .expect(201)
    ).body;
    await walk(api, o.id, ['ready_to_ship', 'shipped', 'in_transit', 'delivered']);
    await status(api, o.id, 'return_requested', { reason: 'Arrived damaged' }).expect(200);
    const brokenLine = o.items.find((i: { variantId: string }) => i.variantId === broken.id);
    await status(api, o.id, 'returned', {
      reason: 'Inspected',
      returnedItems: [{ itemId: brokenLine.id, condition: 'DAMAGED' }],
    }).expect(200);
    expect(await level(api, good.id)).toMatchObject({ onHand: 10, damaged: 0 });
    expect(await level(api, broken.id)).toMatchObject({ onHand: 7, damaged: 3, available: 7 });
    expect(
      (
        await status(api, o.id, 'returned', {
          reason: 'x'.repeat(5),
          returnedItems: [{ itemId: '0197b0a0-0000-7000-8000-00000000dead', condition: 'DAMAGED' }],
        })
      ).status,
    ).toBe(200); // already returned: harmless
  });

  it('refuses a returned item that is not on the order', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const o = await delivered(api, v, 1);
    await status(api, o.id, 'return_requested', { reason: 'Changed my mind' }).expect(200);
    const r = await status(api, o.id, 'returned', {
      reason: 'Back',
      returnedItems: [{ itemId: '0197b0a0-0000-7000-8000-00000000dead', condition: 'DAMAGED' }],
    });
    expect(r.status).toBe(400);
    expect(await level(api, v.id)).toMatchObject({ onHand: 9 }); // nothing came back
  });

  it('an order that was returned from a failed delivery restocks too', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const o = (
      await api
        .post('/v1/orders', body([{ variantId: v.id, quantity: 2 }], { confirm: true }))
        .expect(201)
    ).body;
    await walk(api, o.id, ['ready_to_ship', 'shipped', 'in_transit']);
    await status(api, o.id, 'delivery_failed', { reason: 'Refused' }).expect(200);
    await status(api, o.id, 'return_requested', { reason: 'Courier returning' }).expect(200);
    await status(api, o.id, 'returned', { reason: 'Received' }).expect(200);
    expect(await level(api, v.id)).toMatchObject({ onHand: 5, reserved: 0 });
  });

  it('only shipped orders can come back, so stock is never added for goods that never left', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const o = (
      await api
        .post('/v1/orders', body([{ variantId: v.id, quantity: 2 }], { confirm: true }))
        .expect(201)
    ).body;
    expect((await status(api, o.id, 'returned', { reason: 'Never left' })).status).toBe(409);
    expect((await status(api, o.id, 'return_requested', { reason: 'Never left' })).status).toBe(
      409,
    );
    expect(await level(api, v.id)).toMatchObject({ onHand: 5, reserved: 2 });
  });
});

describe('editing', () => {
  it('re-works the totals when items or amounts change while pending', async () => {
    const { owner, api } = await shop();
    const a = await item(owner, 10, { priceMinor: 100_000 });
    const b = await item(owner, 10, { priceMinor: 50_000 });
    const o = (
      await api
        .post(
          '/v1/orders',
          body([{ variantId: a.id, quantity: 1 }], { deliveryChargeMinor: 6_000 }),
        )
        .expect(201)
    ).body;
    expect(o.totalMinor).toBe(106_000);
    const e = (
      await api
        .patch(`/v1/orders/${o.id}`, {
          items: [
            { variantId: a.id, quantity: 2 },
            { variantId: b.id, quantity: 1 },
          ],
          discountMinor: 20_000,
          advancePaidMinor: 30_000,
        })
        .expect(200)
    ).body;
    expect(e).toMatchObject({
      subtotalMinor: 250_000,
      discountMinor: 20_000,
      deliveryChargeMinor: 6_000,
      totalMinor: 236_000,
      advancePaidMinor: 30_000,
      codAmountMinor: 206_000,
    });
    expect(e.items).toHaveLength(2);
    expect(e.version).toBe(o.version + 1);
    expect((await api.patch(`/v1/orders/${o.id}`, { totalMinor: 1 })).status).toBe(400); // totals are not the client's to set
    // changing only the delivery charge recomputes from the existing lines
    const d = (await api.patch(`/v1/orders/${o.id}`, { deliveryChargeMinor: 0 }).expect(200)).body;
    expect(d).toMatchObject({ totalMinor: 230_000, codAmountMinor: 200_000 });
    // an advance bigger than the new total is refused
    expect((await api.patch(`/v1/orders/${o.id}`, { advancePaidMinor: 999_999 })).status).toBe(400);
  });

  it('once confirmed, items and money are frozen but the address and notes can change', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const o = (
      await api
        .post('/v1/orders', body([{ variantId: v.id, quantity: 2 }], { confirm: true }))
        .expect(201)
    ).body;
    for (const frozen of [
      { items: [{ variantId: v.id, quantity: 5 }] },
      { discountMinor: 100 },
      { deliveryChargeMinor: 100 },
      { advancePaidMinor: 100 },
    ]) {
      const r = await api.patch(`/v1/orders/${o.id}`, frozen);
      expect(r.status, JSON.stringify(frozen)).toBe(409);
    }
    const ok = (
      await api
        .patch(`/v1/orders/${o.id}`, {
          address: address({ line1: 'New flat, Gulshan' }),
          notes: 'Call before delivery',
        })
        .expect(200)
    ).body;
    expect(ok.shipping.line1).toBe('New flat, Gulshan');
    expect(ok.notes).toBe('Call before delivery');
    expect(ok.totalMinor).toBe(o.totalMinor);
    expect(await level(api, v.id)).toMatchObject({ reserved: 2 });
  });

  it('after shipping only notes can change; finished orders cannot be edited', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const o = (
      await api
        .post('/v1/orders', body([{ variantId: v.id, quantity: 1 }], { confirm: true }))
        .expect(201)
    ).body;
    await walk(api, o.id, ['ready_to_ship', 'shipped']);
    expect((await api.patch(`/v1/orders/${o.id}`, { address: address() })).status).toBe(409);
    await api.patch(`/v1/orders/${o.id}`, { notes: 'Courier called' }).expect(200);
    const c = (
      await api
        .post(
          '/v1/orders',
          body([{ variantId: v.id, quantity: 1 }], {
            customer: { name: 'Other', phone: newPhone() },
          }),
        )
        .expect(201)
    ).body;
    await status(api, c.id, 'cancelled', { reason: 'No longer needed' }).expect(200);
    expect((await api.patch(`/v1/orders/${c.id}`, { notes: 'too late' })).status).toBe(409);
  });
});

describe('records that cannot be rewritten', () => {
  it('the database refuses totals that do not add up, even from a bug', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const o = (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 1 }])).expect(201))
      .body;
    const tenantId = (await t.db.withContext({}, async () => null), owner.tenant.id);
    await expect(
      t.db.withContext(
        { tenantId },
        (tx) =>
          tx.$executeRaw`UPDATE orders SET total_minor = total_minor + 1 WHERE id = ${o.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      t.db.withContext(
        { tenantId },
        (tx) =>
          tx.$executeRaw`UPDATE orders SET cod_amount_minor = 0, advance_paid_minor = 0 WHERE id = ${o.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      t.db.withContext(
        { tenantId },
        (tx) =>
          tx.$executeRaw`UPDATE order_items SET line_total_minor = 1 WHERE order_id = ${o.id}::uuid`,
      ),
    ).rejects.toThrow();
    expect((await api.get(`/v1/orders/${o.id}`)).body.totalMinor).toBe(o.totalMinor);
  });

  it('the status history can be added to and read, never changed or deleted', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const o = (
      await api
        .post('/v1/orders', body([{ variantId: v.id, quantity: 1 }], { confirm: true }))
        .expect(201)
    ).body;
    const tenantId = owner.tenant.id;
    await expect(
      t.db.withContext(
        { tenantId },
        (tx) =>
          tx.$executeRaw`UPDATE order_status_history SET reason = 'edited' WHERE order_id = ${o.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.db.withContext(
        { tenantId },
        (tx) => tx.$executeRaw`DELETE FROM order_status_history WHERE order_id = ${o.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.db.withContext({ tenantId }, (tx) => tx.$executeRaw`TRUNCATE order_status_history`),
    ).rejects.toThrow(/permission denied/);
    expect((await api.get(`/v1/orders/${o.id}`)).body.history).toHaveLength(2);
  });

  it('records who did what in the audit trail', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const o = (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 1 }])).expect(201))
      .body;
    await api.patch(`/v1/orders/${o.id}`, { notes: 'edit' }).expect(200);
    await status(api, o.id, 'confirmed').expect(200);
    await status(api, o.id, 'cancelled', { reason: 'Customer cancelled' }).expect(200);
    const log = (await api.get('/v1/audit-logs?limit=100').expect(200)).body.items as {
      action: string;
      targetId: string;
      actorUserId: string;
    }[];
    const mine = log.filter((e) => e.targetId === o.id).map((e) => e.action);
    expect(mine).toEqual(
      expect.arrayContaining([
        'order.created',
        'order.updated',
        'order.status_changed',
        'order.cancelled',
      ]),
    );
    expect(log.find((e) => e.action === 'order.created')!.actorUserId).toBe(owner.user.id);
  });

  it('audit entries and history never contain customer contact details', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const o = (
      await api
        .post(
          '/v1/orders',
          body([{ variantId: v.id, quantity: 1 }], {
            customer: { name: 'Secret Person', phone: '01712999888' },
            address: address({ phone: '01712999888', line1: 'Hidden lane' }),
          }),
        )
        .expect(201)
    ).body;
    await api
      .patch(`/v1/orders/${o.id}`, {
        address: address({ line1: 'Another hidden lane', phone: '01712999888' }),
      })
      .expect(200);
    const rows = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.auditLog.findMany({ where: { tenantId: owner.tenant.id } }),
    );
    const text = JSON.stringify(rows.map((r) => r.metadata));
    expect(text).not.toContain('1712999888');
    expect(text).not.toContain('Hidden lane');
    expect(text).not.toContain('Secret Person');
  });
});

describe('CHECKPOINT: create an order, reserve stock, change its status, cancel another, and verify the books', () => {
  it('inventory and order totals stay correct through the whole sequence', async () => {
    const { owner, api } = await shop();
    const tee = await item(owner, 20, { priceMinor: 85_050, sku: 'CKPT-TEE' }); // ৳850.50
    const mug = await item(owner, 12, { priceMinor: 30_000, sku: 'CKPT-MUG' }); // ৳300.00

    // 1. create order A (2 tees + 1 mug, ৳100 off, ৳60 delivery, ৳200 advance) and reserve its stock
    const a = (
      await api
        .post(
          '/v1/orders',
          body(
            [
              { variantId: tee.id, quantity: 2 },
              { variantId: mug.id, quantity: 1 },
            ],
            {
              discountMinor: 10_000,
              deliveryChargeMinor: 6_000,
              advancePaidMinor: 20_000,
              confirm: true,
              customer: { name: 'Checkpoint A', phone: newPhone() },
            },
          ),
        )
        .expect(201)
    ).body;
    // totals: 2 x 850.50 + 300.00 = 2001.00 ; - 100.00 + 60.00 = 1961.00 ; COD = 1961.00 - 200.00 = 1761.00
    expect(a).toMatchObject({
      status: 'confirmed',
      subtotalMinor: 200_100,
      totalMinor: 196_100,
      advancePaidMinor: 20_000,
      codAmountMinor: 176_100,
      stockHeld: true,
    });
    expect(
      a.items.reduce((n: number, i: { lineTotalMinor: number }) => n + i.lineTotalMinor, 0),
    ).toBe(a.subtotalMinor);
    expect(await level(api, tee.id)).toMatchObject({ onHand: 20, reserved: 2, available: 18 });
    expect(await level(api, mug.id)).toMatchObject({ onHand: 12, reserved: 1, available: 11 });

    // 2. create order B (5 tees) and reserve it too
    const b = (
      await api
        .post(
          '/v1/orders',
          body([{ variantId: tee.id, quantity: 5 }], {
            confirm: true,
            customer: { name: 'Checkpoint B', phone: newPhone() },
          }),
        )
        .expect(201)
    ).body;
    expect(b.totalMinor).toBe(425_250); // 5 x 850.50
    expect(await level(api, tee.id)).toMatchObject({ onHand: 20, reserved: 7, available: 13 });

    // 3. change order A's status along the way: ready to ship, then shipped (its units leave)
    await status(api, a.id, 'ready_to_ship').expect(200);
    await status(api, a.id, 'shipped').expect(200);
    expect(await level(api, tee.id)).toMatchObject({ onHand: 18, reserved: 5, available: 13 });
    expect(await level(api, mug.id)).toMatchObject({ onHand: 11, reserved: 0, available: 11 });

    // 4. cancel order B: its 5 reserved units go back on sale
    await status(api, b.id, 'cancelled', { reason: 'Customer cancelled the second order' }).expect(
      200,
    );
    expect(await level(api, tee.id)).toMatchObject({ onHand: 18, reserved: 0, available: 18 });

    // 5. totals did not move, and neither did anything else
    const aNow = (await api.get(`/v1/orders/${a.id}`)).body;
    const bNow = (await api.get(`/v1/orders/${b.id}`)).body;
    expect(aNow).toMatchObject({
      status: 'shipped',
      subtotalMinor: 200_100,
      totalMinor: 196_100,
      codAmountMinor: 176_100,
    });
    expect(bNow).toMatchObject({ status: 'cancelled', totalMinor: 425_250 });
    expect(aNow.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'pending_confirmation',
      'confirmed',
      'ready_to_ship',
      'shipped',
    ]);
    expect(bNow.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'pending_confirmation',
      'confirmed',
      'cancelled',
    ]);

    // 6. the stock ledger explains every unit, and matches the levels
    for (const [v, onHand] of [
      [tee, 18],
      [mug, 11],
    ] as const) {
      const ledger = (await api.get(`/v1/inventory/movements?variantId=${v.id}&limit=100`)).body
        .items as {
        type: string;
        onHandDelta: number;
        reservedDelta: number;
        referenceType: string | null;
      }[];
      expect(ledger.reduce((n, m) => n + m.onHandDelta, 0)).toBe(onHand);
      expect(ledger.reduce((n, m) => n + m.reservedDelta, 0)).toBe(0);
      for (const m of ledger.filter((x) => x.type !== 'RECEIVE'))
        expect(m.referenceType).toBe('order'); // nothing unexplained
    }
    const tally = async (type: string) => (await moves(api, tee.id, type)).length;
    expect([await tally('RESERVE'), await tally('SHIP'), await tally('RELEASE')]).toEqual([
      2, 1, 1,
    ]);
    // and the order list adds up to the same figures
    const list = (await api.get('/v1/orders?limit=10')).body;
    expect(list.total).toBe(2);
    expect(
      list.items
        .map((o: { totalMinor: number }) => o.totalMinor)
        .sort((x: number, y: number) => x - y),
    ).toEqual([196_100, 425_250]);
  });
});
