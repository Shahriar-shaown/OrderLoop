import {
  canTransition,
  holdsStock,
  parseCsv,
  stockEffect,
  type OrderStatus,
} from '@orderloop/domain';
import fc from 'fast-check';
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
let phoneSeq = 5000;
const newPhone = () => `0171${String(1000000 + ++phoneSeq).slice(-7)}`;

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
  return { owner, api: call(owner) };
};
async function item(
  owner: Who,
  stock: number,
  opts: { priceMinor?: number; sku?: string; name?: string } = {},
) {
  const { variant } = await createProduct(t, owner.accessToken, {
    priceMinor: opts.priceMinor ?? 100_000,
    ...(opts.sku ? { sku: opts.sku } : {}),
    ...(opts.name ? { name: opts.name } : {}),
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
const body = (items: object[], extra: object = {}) => ({
  customer: { name: 'Rina Akter', phone: '01712345678' },
  address: address(),
  items,
  idempotencyKey: key(),
  ...extra,
});
const make = async (api: Api, items: object[], extra: object = {}) =>
  (await api.post('/v1/orders', body(items, extra)).expect(201)).body as {
    id: string;
    orderNumber: number;
    customer: { id: string };
    items: { id: string }[];
  };
const status = (api: Api, id: string, to: string, extra: object = {}) =>
  api.post(`/v1/orders/${id}/status`, { status: to, ...extra });
const level = async (api: Api, variantId: string) =>
  ((await api.get(`/v1/inventory?variantId=${variantId}`)).body.items[0] ?? {
    onHand: 0,
    reserved: 0,
    available: 0,
    damaged: 0,
  }) as {
    onHand: number;
    reserved: number;
    available: number;
    damaged: number;
  };

describe('searching, filtering, sorting and paging orders', () => {
  async function seed() {
    const { owner, api } = await shop();
    const tee = await item(owner, 100, {
      sku: 'SRCH-TEE',
      name: 'Searchable tee',
      priceMinor: 50_000,
    });
    const mug = await item(owner, 100, { sku: 'SRCH-MUG', name: 'Blue mug', priceMinor: 20_000 });
    const buyers = [
      { name: 'Anika Rahman', phone: '01711000001' },
      { name: 'Bashir Ahmed', phone: '01811000002' },
      { name: 'Chitra Sen', phone: '01911000003' },
    ];
    const orders: { id: string; orderNumber: number }[] = [];
    // 9 orders with varied totals, sources and statuses
    for (let i = 0; i < 9; i++) {
      const b = buyers[i % 3]!;
      const o = await make(api, [{ variantId: i % 2 ? mug.id : tee.id, quantity: i + 1 }], {
        customer: b,
        address: address({ phone: b.phone, recipientName: b.name }),
        source: (['facebook', 'instagram', 'whatsapp'] as const)[i % 3],
        deliveryChargeMinor: i * 100,
      });
      orders.push(o);
    }
    await status(api, orders[0]!.id, 'confirmed').expect(200);
    await status(api, orders[1]!.id, 'confirmed').expect(200);
    await status(api, orders[2]!.id, 'cancelled', { reason: 'No answer on the phone' }).expect(200);
    return { owner, api, tee, mug, orders };
  }
  const nums = (res: { body: { items: { orderNumber: number }[] } }) =>
    res.body.items.map((o) => o.orderNumber);

  it('pages through everything exactly once, in every sort order and direction', async () => {
    const { api } = await seed();
    for (const sort of ['createdAt', 'orderNumber', 'totalMinor', 'status'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const seen: number[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const url: string = `/v1/orders?sort=${sort}&dir=${dir}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
          const res: {
            body: { total: number; nextCursor: string | null; items: { orderNumber: number }[] };
          } = await api.get(url).expect(200);
          expect(res.body.total).toBe(9);
          seen.push(...nums(res));
          cursor = res.body.nextCursor;
          pages++;
          expect(pages).toBeLessThan(20);
        } while (cursor);
        expect(new Set(seen).size, `${sort} ${dir}`).toBe(9); // no repeats, no gaps
        expect(pages).toBe(5);
        const all = (await api.get(`/v1/orders?sort=${sort}&dir=${dir}&limit=100`).expect(200)).body
          .items as Record<string, number>[];
        expect(seen).toEqual(all.map((o) => o['orderNumber']));
        if (sort === 'orderNumber')
          expect(seen).toEqual([...seen].sort((a, b) => (dir === 'asc' ? a - b : b - a)));
        if (sort === 'totalMinor') {
          const totals = all.map((o) => o['totalMinor']!);
          expect(totals).toEqual([...totals].sort((a, b) => (dir === 'asc' ? a - b : b - a)));
        }
      }
    }
  });

  it('stays stable when new orders arrive between pages', async () => {
    const { owner, api, tee } = await seed();
    const first = await api.get('/v1/orders?limit=3').expect(200); // newest first
    await make(api, [{ variantId: tee.id, quantity: 1 }], {
      customer: { name: 'Late Comer', phone: newPhone() },
    });
    const second = await api.get(`/v1/orders?limit=3&cursor=${first.body.nextCursor}`).expect(200);
    expect(nums(second).every((n) => !nums(first).includes(n))).toBe(true);
    expect(owner.accessToken).toBeTruthy();
  });

  it('filters by status (one or several), source, amount and customer', async () => {
    const { api, orders } = await seed();
    expect((await api.get('/v1/orders?status=confirmed').expect(200)).body.total).toBe(2);
    expect((await api.get('/v1/orders?status=confirmed,cancelled').expect(200)).body.total).toBe(3);
    expect((await api.get('/v1/orders?status=pending_confirmation').expect(200)).body.total).toBe(
      6,
    );
    expect((await api.get('/v1/orders?source=facebook').expect(200)).body.total).toBe(3);
    expect(
      (await api.get('/v1/orders?source=facebook,whatsapp&status=pending_confirmation').expect(200))
        .body.total,
    ).toBe(4);
    const big = (await api.get('/v1/orders?minTotalMinor=200000&limit=100').expect(200)).body
      .items as { totalMinor: number }[];
    expect(big.length).toBeGreaterThan(0);
    for (const o of big) expect(o.totalMinor).toBeGreaterThanOrEqual(200_000);
    const small = (await api.get('/v1/orders?maxTotalMinor=100000&limit=100').expect(200)).body
      .items as { totalMinor: number }[];
    for (const o of small) expect(o.totalMinor).toBeLessThanOrEqual(100_000);
    const cust = (await api.get(`/v1/orders/${orders[0]!.id}`).expect(200)).body.customer
      .id as string;
    expect((await api.get(`/v1/orders?customerId=${cust}`).expect(200)).body.total).toBe(3);
    expect((await api.get('/v1/orders?status=shipped').expect(200)).body.items).toEqual([]);
  });

  it('filters by creation date in the business’s own time zone', async () => {
    const { api } = await seed();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
    expect((await api.get(`/v1/orders?from=${today}&to=${today}`).expect(200)).body.total).toBe(9);
    expect((await api.get('/v1/orders?from=2020-01-01&to=2020-12-31').expect(200)).body.total).toBe(
      0,
    );
    expect((await api.get(`/v1/orders?from=${today}`).expect(200)).body.total).toBe(9);
    expect((await api.get('/v1/orders?to=2020-12-31').expect(200)).body.total).toBe(0);
    expect((await api.get('/v1/orders?from=31-12-2020')).status).toBe(400);
  });

  it('searches by order number, customer name, phone fragment, SKU and product name', async () => {
    const { api, orders } = await seed();
    const number = orders[3]!.orderNumber;
    expect(nums(await api.get(`/v1/orders?q=${number}`).expect(200))).toContain(number);
    expect(nums(await api.get(`/v1/orders?q=%23${number}`).expect(200))).toEqual([number]);
    expect((await api.get('/v1/orders?q=anika').expect(200)).body.total).toBe(3);
    expect((await api.get('/v1/orders?q=BASHIR%20ahmed').expect(200)).body.total).toBe(3);
    expect((await api.get('/v1/orders?q=01811').expect(200)).body.total).toBe(3); // phone fragment, local form
    expect((await api.get('/v1/orders?q=%2B880191').expect(200)).body.total).toBe(3); // international form
    expect((await api.get('/v1/orders?q=srch-mug').expect(200)).body.total).toBe(4);
    expect((await api.get('/v1/orders?q=searchable').expect(200)).body.total).toBe(5);
    expect((await api.get('/v1/orders?q=nobody-by-this-name').expect(200)).body.total).toBe(0);
    // combine with a filter and a sort
    const combined = await api
      .get('/v1/orders?q=anika&status=pending_confirmation&sort=totalMinor&dir=asc')
      .expect(200);
    expect(combined.body.total).toBe(2);
  });

  it('treats % and _ in a search as ordinary characters', async () => {
    const { api } = await seed();
    expect((await api.get('/v1/orders?q=%25').expect(200)).body.total).toBe(0);
    expect((await api.get('/v1/orders?q=_').expect(200)).body.total).toBe(0);
    expect((await api.get('/v1/orders?q=%27%20OR%201%3D1%20--').expect(200)).body.total).toBe(0);
  });

  it('refuses a malformed cursor, bad sort and bad filters', async () => {
    const { api } = await seed();
    expect((await api.get('/v1/orders?cursor=garbage')).status).toBe(400);
    expect((await api.get('/v1/orders?sort=password')).status).toBe(400);
    expect((await api.get('/v1/orders?status=shipping')).status).toBe(400);
    expect((await api.get('/v1/orders?limit=1000')).status).toBe(400);
    expect((await api.get('/v1/orders?source=telepathy')).status).toBe(400);
  });
});

describe('customers and their history', () => {
  it('adds, finds and edits customers; a phone number is one customer however it is written', async () => {
    const { api } = await shop();
    const c = (
      await api
        .post('/v1/customers', {
          name: 'Nasrin Sultana',
          phone: '01712-345678',
          email: 'NASRIN@example.test',
        })
        .expect(201)
    ).body;
    expect(c).toMatchObject({
      phone: '+8801712345678',
      email: 'nasrin@example.test',
      stats: { ordersCount: 0 },
    });
    for (const again of ['+8801712345678', '8801712345678', '01712 345 678', '০১৭১২৩৪৫৬৭৮'])
      expect(
        (await api.post('/v1/customers', { name: 'Someone Else', phone: again })).status,
        again,
      ).toBe(409);
    expect((await api.post('/v1/customers', { name: 'N', phone: '01712345679' })).status).toBe(400);
    expect(
      (await api.post('/v1/customers', { name: 'Fine Name', phone: 'not a phone' })).status,
    ).toBe(400);
    const found = (await api.get('/v1/customers?q=nasrin').expect(200)).body.items;
    expect(found).toHaveLength(1);
    expect((await api.get('/v1/customers?q=1712345').expect(200)).body.items).toHaveLength(1);
    const edited = (
      await api
        .patch(`/v1/customers/${c.id}`, { notes: 'Prefers morning delivery', phone: '01912345678' })
        .expect(200)
    ).body;
    expect(edited).toMatchObject({ notes: 'Prefers morning delivery', phone: '+8801912345678' });
    const other = (
      await api.post('/v1/customers', { name: 'Taken Phone', phone: '01812345678' }).expect(201)
    ).body;
    expect((await api.patch(`/v1/customers/${other.id}`, { phone: '01912345678' })).status).toBe(
      409,
    );
    expect((await api.patch(`/v1/customers/${other.id}`, {})).status).toBe(400);
  });

  it('manages addresses: first is the default, one default at a time, deleting the default promotes another', async () => {
    const { api } = await shop();
    const c = (
      await api.post('/v1/customers', { name: 'Karim Uddin', phone: '01812345678' }).expect(201)
    ).body;
    const a1 = (
      await api.post(`/v1/customers/${c.id}/addresses`, address({ label: 'Home' })).expect(201)
    ).body;
    const a2 = (
      await api
        .post(
          `/v1/customers/${c.id}/addresses`,
          address({ label: 'Office', line1: 'Motijheel office' }),
        )
        .expect(201)
    ).body;
    expect([a1.isDefault, a2.isDefault]).toEqual([true, false]);
    await api.patch(`/v1/customers/${c.id}/addresses/${a2.id}`, { isDefault: true }).expect(200);
    let detail = (await api.get(`/v1/customers/${c.id}`).expect(200)).body;
    expect(
      detail.addresses
        .filter((a: { isDefault: boolean }) => a.isDefault)
        .map((a: { id: string }) => a.id),
    ).toEqual([a2.id]);
    await api.del(`/v1/customers/${c.id}/addresses/${a2.id}`).expect(200);
    detail = (await api.get(`/v1/customers/${c.id}`).expect(200)).body;
    expect(detail.addresses).toHaveLength(1);
    expect(detail.addresses[0]).toMatchObject({ id: a1.id, isDefault: true });
    expect(
      (await api.post(`/v1/customers/${c.id}/addresses`, address({ division: 'Atlantis' }))).status,
    ).toBe(400);
    expect(
      (await api.post(`/v1/customers/${c.id}/addresses`, address({ postalCode: '12' }))).status,
    ).toBe(400);
    expect((await api.del(`/v1/customers/${c.id}/addresses/${a2.id}`)).status).toBe(404);
  });

  it('keeps the whole order history, with plain counts and no verdict on the customer', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 100);
    const buyer = { name: 'Repeat Buyer', phone: '01755000111' };
    const ids: string[] = [];
    for (let i = 0; i < 6; i++)
      ids.push((await make(api, [{ variantId: v.id, quantity: 1 }], { customer: buyer })).id);
    const cust = (await api.get(`/v1/orders/${ids[0]}`)).body.customer.id as string;
    for (const id of ids.slice(0, 2)) {
      await status(api, id, 'confirmed').expect(200);
      for (const s of ['ready_to_ship', 'shipped', 'in_transit', 'delivered'])
        await status(api, id, s).expect(200);
    }
    await status(api, ids[2]!, 'cancelled', { reason: 'Changed mind' }).expect(200);
    await status(api, ids[3]!, 'confirmed').expect(200);
    for (const s of ['ready_to_ship', 'shipped', 'in_transit', 'delivered'])
      await status(api, ids[3]!, s).expect(200);
    await status(api, ids[3]!, 'return_requested', { reason: 'Wrong size' }).expect(200);
    await status(api, ids[3]!, 'returned', { reason: 'Received' }).expect(200);
    const detail = (await api.get(`/v1/customers/${cust}`).expect(200)).body;
    expect(detail.stats).toMatchObject({
      ordersCount: 6,
      deliveredCount: 2,
      cancelledCount: 1,
      returnedCount: 1,
      deliveredValueMinor: 200_000,
    });
    expect(detail.stats.lastOrderAt).toBeTruthy();
    // never a score, rating, flag or label about the customer
    const keys = JSON.stringify(detail);
    for (const word of [
      'risk',
      'fraud',
      'score',
      'trust',
      'blacklist',
      'blocked',
      'flag',
      'suspicious',
      'rating',
    ])
      expect(keys.toLowerCase()).not.toContain(word);
    expect(Object.keys(detail.stats).sort()).toEqual([
      'cancelledCount',
      'deliveredCount',
      'deliveredValueMinor',
      'lastOrderAt',
      'ordersCount',
      'returnedCount',
    ]);
    // history pages newest first
    const page1 = (await api.get(`/v1/customers/${cust}/orders?limit=4`).expect(200)).body;
    expect(page1.total).toBe(6);
    expect(page1.items).toHaveLength(4);
    const page2 = (
      await api.get(`/v1/customers/${cust}/orders?limit=4&cursor=${page1.nextCursor}`).expect(200)
    ).body;
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const numbers = [...page1.items, ...page2.items].map(
      (o: { orderNumber: number }) => o.orderNumber,
    );
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    // a returned or cancelled customer can still order: nothing blocks them
    expect(
      (await api.post('/v1/orders', body([{ variantId: v.id, quantity: 1 }], { customer: buyer })))
        .status,
    ).toBe(201);
  });
});

describe('possible duplicate orders', () => {
  it('flags a very recent order for the same phone, and a shared item, without ever blocking', async () => {
    const { owner, api } = await shop();
    const a = await item(owner, 20);
    const b = await item(owner, 20);
    const first = await make(api, [{ variantId: a.id, quantity: 1 }]);
    // another order seconds later for the same number, different item
    const check = (
      await api
        .post('/v1/orders/duplicate-check', { phone: '+880 1712-345678', variantIds: [b.id] })
        .expect(200)
    ).body;
    expect(check).toHaveLength(1);
    expect(check[0]).toMatchObject({
      orderId: first.id,
      orderNumber: first.orderNumber,
      status: 'pending_confirmation',
    });
    expect(check[0].reasons.join(' ')).toMatch(/ago for the same phone number/);
    expect(check[0].reasons.join(' ')).not.toMatch(/Same item/);
    const same = (
      await api
        .post('/v1/orders/duplicate-check', { phone: '01712345678', variantIds: [a.id] })
        .expect(200)
    ).body;
    expect(same[0].reasons.join(' ')).toMatch(/Same item: /);
    // a different number is not a duplicate
    expect(
      (
        await api
          .post('/v1/orders/duplicate-check', { phone: '01999888777', variantIds: [a.id] })
          .expect(200)
      ).body,
    ).toEqual([]);
    // and the order is created anyway
    const second = await api
      .post('/v1/orders', body([{ variantId: a.id, quantity: 1 }]))
      .expect(201);
    const dupes = (await api.get(`/v1/orders/${second.body.id}/duplicates`).expect(200)).body;
    expect(dupes.map((d: { orderId: string }) => d.orderId)).toEqual([first.id]);
    expect(
      (await api.get(`/v1/orders/${first.id}/duplicates`).expect(200)).body.map(
        (d: { orderId: string }) => d.orderId,
      ),
    ).toEqual([second.body.id]);
  });

  it('ignores cancelled orders, the order itself, and other customers', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 20);
    const first = await make(api, [{ variantId: v.id, quantity: 1 }]);
    await status(api, first.id, 'cancelled', { reason: 'Customer called back' }).expect(200);
    expect(
      (
        await api
          .post('/v1/orders/duplicate-check', { phone: '01712345678', variantIds: [v.id] })
          .expect(200)
      ).body,
    ).toEqual([]);
    expect((await api.get(`/v1/orders/${first.id}/duplicates`).expect(200)).body).toEqual([]);
    const lone = await make(api, [{ variantId: v.id, quantity: 1 }], {
      customer: { name: 'Lone', phone: newPhone() },
    });
    expect((await api.get(`/v1/orders/${lone.id}/duplicates`).expect(200)).body).toEqual([]);
  });

  it('never looks across businesses', async () => {
    const a = await shop();
    const b = await shop();
    const va = await item(a.owner, 5);
    await make(a.api, [{ variantId: va.id, quantity: 1 }]);
    expect(
      (
        await b.api
          .post('/v1/orders/duplicate-check', { phone: '01712345678', variantIds: [va.id] })
          .expect(200)
      ).body,
    ).toEqual([]);
  });
});

describe('bulk actions', () => {
  it('moves many orders at once, reporting each one, and one failure does not stop the rest', async () => {
    const { owner, api } = await shop();
    const plenty = await item(owner, 10);
    const scarce = await item(owner, 1);
    const ok1 = await make(api, [{ variantId: plenty.id, quantity: 2 }], {
      customer: { name: 'One', phone: newPhone() },
    });
    const short = await make(api, [{ variantId: scarce.id, quantity: 5 }], {
      customer: { name: 'Two', phone: newPhone() },
    });
    const ok2 = await make(api, [{ variantId: plenty.id, quantity: 3 }], {
      customer: { name: 'Three', phone: newPhone() },
    });
    const res = (
      await api
        .post('/v1/orders/bulk-status', {
          orderIds: [ok1.id, short.id, ok2.id],
          status: 'confirmed',
        })
        .expect(200)
    ).body;
    expect(res).toMatchObject({ succeeded: 2, failed: 1 });
    const byId = new Map(res.results.map((r: { orderId: string }) => [r.orderId, r]));
    expect(byId.get(ok1.id)).toMatchObject({
      ok: true,
      status: 'confirmed',
      orderNumber: ok1.orderNumber,
    });
    expect(byId.get(short.id)).toMatchObject({
      ok: false,
      status: 'pending_confirmation',
      error: { code: 'insufficient_stock' },
    });
    expect(await level(api, plenty.id)).toMatchObject({ reserved: 5 });
    expect(await level(api, scarce.id)).toMatchObject({ reserved: 0 });
  });

  it('cancels in bulk once, however often it is repeated, and reports orders that cannot move', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 20);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push(
        (
          await make(api, [{ variantId: v.id, quantity: 2 }], {
            customer: { name: `B${i}`, phone: newPhone() },
            confirm: true,
          })
        ).id,
      );
    for (const s of ['ready_to_ship', 'shipped']) await status(api, ids[3]!, s).expect(200);
    const req = { orderIds: ids, status: 'cancelled', reason: 'Bulk cancel: courier strike' };
    const first = (await api.post('/v1/orders/bulk-status', req).expect(200)).body;
    expect(first).toMatchObject({ succeeded: 3, failed: 1 });
    expect(first.results.find((r: { orderId: string }) => r.orderId === ids[3])).toMatchObject({
      ok: false,
      error: { code: 'invalid_transition' },
    });
    const again = (await api.post('/v1/orders/bulk-status', req).expect(200)).body;
    expect(again).toMatchObject({ succeeded: 3, failed: 1 });
    expect(await level(api, v.id)).toMatchObject({ onHand: 18, reserved: 0 }); // three released once; the shipped one left
    const releases = (
      await api.get(`/v1/inventory/movements?variantId=${v.id}&type=RELEASE`).expect(200)
    ).body.items;
    expect(releases).toHaveLength(3);
  });

  it('limits a bulk request, needs a reason where one is due, and is audited', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    const o = await make(api, [{ variantId: v.id, quantity: 1 }]);
    expect(
      (await api.post('/v1/orders/bulk-status', { orderIds: [], status: 'confirmed' })).status,
    ).toBe(400);
    const many = Array.from({ length: 101 }, () => '0197b0a0-0000-7000-8000-00000000dead');
    expect(
      (await api.post('/v1/orders/bulk-status', { orderIds: many, status: 'confirmed' })).status,
    ).toBe(400);
    const noReason = (
      await api
        .post('/v1/orders/bulk-status', { orderIds: [o.id], status: 'cancelled' })
        .expect(200)
    ).body;
    expect(noReason).toMatchObject({
      succeeded: 0,
      failed: 1,
      results: [{ error: { code: 'validation_failed' } }],
    });
    await api
      .post('/v1/orders/bulk-status', { orderIds: [o.id, o.id], status: 'confirmed' })
      .expect(200); // duplicates collapse
    const log = (await api.get('/v1/audit-logs?limit=50').expect(200)).body.items as {
      action: string;
    }[];
    expect(log.map((e) => e.action)).toContain('order.bulk_status');
    void owner;
  });
});

describe('importing and exporting orders', () => {
  const HEAD =
    'order_ref,customer_name,phone,address_line,area,district,division,sku,quantity,unit_price,discount,delivery_charge,advance_paid,source,notes\n';

  it('checks a file first, then creates pending orders with server-side totals, once', async () => {
    const { owner, api } = await shop();
    const tee = await item(owner, 10, { sku: 'IMP-TEE', priceMinor: 85_050 });
    const mug = await item(owner, 10, { sku: 'IMP-MUG', priceMinor: 30_000 });
    const csv =
      HEAD +
      'F-1,Rina Akter,01712-345678,House 5 Road 3,Dhanmondi,Dhaka,Dhaka,IMP-TEE,2,,100,60,200,facebook,Eid offer\n' +
      'F-1,,,,,,,IMP-MUG,1,250,,,,,\n' +
      'F-2,Karim,01812345678,Village Sadar,Sadar,Cumilla,Chattogram,imp-tee,1,,,,,whatsapp,\n' +
      'F-3,Bad Phone,12345,Road,Area,Dhaka,Dhaka,IMP-TEE,1,,,,,,\n' +
      'F-4,Nobody,01912345678,Road,Area,Dhaka,Dhaka,NO-SUCH-SKU,1,,,,,,\n';
    const preview = (await api.post('/v1/imports/orders/validate', { csv }).expect(200)).body;
    expect(preview).toMatchObject({
      fatal: null,
      orderCount: 4,
      validOrders: 2,
      alreadyImported: 0,
      errorCount: 2,
    });
    expect(preview.errors.map((e: { row: number }) => e.row)).toEqual([5, 6]);
    expect(preview.errors[1].message).toMatch(/NO-SUCH-SKU is not in your catalog/);
    // F-1: 2 x 850.50 + 250 = 1951.00, less discount 100.00, plus delivery 60.00 = 1911.00 ; F-2: 850.50
    expect(preview.totalMinor).toBe(191_100 + 85_050);
    expect((await api.get('/v1/orders')).body.total).toBe(0); // checking created nothing

    const result = (await api.post('/v1/imports/orders', { csv }).expect(201)).body;
    expect(result).toMatchObject({ created: 2, alreadyImported: 0, failed: 2 });
    expect(result.orderNumbers).toHaveLength(2);
    const list = (await api.get('/v1/orders?sort=orderNumber&dir=asc').expect(200)).body.items as {
      id: string;
      status: string;
      totalMinor: number;
      codAmountMinor: number;
      source: string;
    }[];
    expect(list.map((o) => o.status)).toEqual(['pending_confirmation', 'pending_confirmation']);
    expect(list[0]).toMatchObject({
      totalMinor: 191_100,
      codAmountMinor: 191_100 - 20_000,
      source: 'facebook',
    });
    expect(list[1]).toMatchObject({ totalMinor: 85_050, source: 'whatsapp' });
    const detail = (await api.get(`/v1/orders/${list[0]!.id}`)).body;
    expect(detail.items.map((i: { unitPriceMinor: number }) => i.unitPriceMinor)).toEqual([
      85_050, 25_000,
    ]); // 250 overrides the catalog
    expect(detail.notes).toBe('Eid offer');
    // importing never holds stock
    expect(await level(api, tee.id)).toMatchObject({ reserved: 0 });
    expect(await level(api, mug.id)).toMatchObject({ reserved: 0 });
    // customers were matched on phone
    expect((await api.get('/v1/customers')).body.items).toHaveLength(2);

    // uploading the same file again creates nothing
    const again = (await api.post('/v1/imports/orders', { csv }).expect(201)).body;
    expect(again).toMatchObject({ created: 0, alreadyImported: 2 });
    expect((await api.get('/v1/orders')).body.total).toBe(2);
    expect((await api.post('/v1/imports/orders/validate', { csv }).expect(200)).body).toMatchObject(
      { validOrders: 0, alreadyImported: 2 },
    );
    const audit = (await api.get('/v1/audit-logs?limit=50').expect(200)).body.items as {
      action: string;
    }[];
    expect(audit.map((e) => e.action)).toContain('orders.imported');
  });

  it('refuses unreadable files, totals in the file, and wrong permissions', async () => {
    const { owner, api } = await shop();
    await item(owner, 1, { sku: 'IMP-X' });
    expect(
      (await api.post('/v1/imports/orders/validate', { csv: 'order_ref,total\nA,5\n' }).expect(200))
        .body.fatal,
    ).toMatch(/Unknown column/);
    expect(
      (await api.post('/v1/imports/orders/validate', { csv: 'order_ref,phone\nA,1\n' }).expect(200))
        .body.fatal,
    ).toMatch(/Missing required/);
    expect((await api.post('/v1/imports/orders', { csv: 'nonsense' })).status).toBe(400);
    const acct = await addMember(t, owner, 'ACCOUNTANT');
    expect((await call(acct).post('/v1/imports/orders/validate', { csv: HEAD })).status).toBe(403);
    expect((await call(acct).post('/v1/imports/orders', { csv: HEAD })).status).toBe(403);
  });

  it('exports orders, one line per row, in plain decimals, honouring the filters, safe against formulas', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 20, { sku: 'EXP-TEE', priceMinor: 125_050 });
    const a = await make(api, [{ variantId: v.id, quantity: 2 }], {
      deliveryChargeMinor: 6_000,
      advancePaidMinor: 50_000,
      source: 'facebook',
      notes: '=HYPERLINK("http://evil.test","x")',
    });
    const b = await make(api, [{ variantId: v.id, quantity: 1 }], {
      customer: { name: 'Other', phone: newPhone() },
      source: 'instagram',
    });
    await status(api, b.id, 'cancelled', { reason: 'Duplicate order' }).expect(200);
    const all = (await api.get('/v1/exports/orders').expect(200)).body;
    expect(all.filename).toMatch(/^orders-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(all.rowCount).toBe(2);
    const [header, ...rows] = parseCsv(all.csv as string);
    const rec = (row: string[]) => Object.fromEntries(header!.map((h, i) => [h, row[i]]));
    const first = rows.map(rec).find((r) => r['order_number'] === String(a.orderNumber))!;
    expect(first).toMatchObject({
      status: 'pending_confirmation',
      sku: 'EXP-TEE',
      quantity: '2',
      unit_price: '1250.50',
      line_total: '2501.00',
      delivery_charge: '60.00',
      advance_paid: '500.00',
      total: '2561.00',
      cod_amount: '2061.00',
      source: 'facebook',
      phone: '01712345678',
    });
    expect(first['notes']).toBe(`'=HYPERLINK("http://evil.test","x")`);
    const filtered = (await api.get('/v1/exports/orders?status=cancelled').expect(200)).body;
    expect(filtered.rowCount).toBe(1);
    expect(filtered.csv).not.toContain(String(a.orderNumber) + ',pending');
    const audit = (await api.get('/v1/audit-logs?limit=50').expect(200)).body.items as {
      action: string;
    }[];
    expect(audit.map((e) => e.action)).toContain('export.orders');
    void owner;
  });
});

describe('tenant isolation', () => {
  async function pair() {
    const a = await shop();
    const b = await shop();
    const va = await item(a.owner, 10);
    const vb = await item(b.owner, 10);
    const orderA = await make(a.api, [{ variantId: va.id, quantity: 2 }], { confirm: true });
    const detailA = (await a.api.get(`/v1/orders/${orderA.id}`)).body;
    const addrId = (await a.api.get(`/v1/customers/${orderA.customer.id}`)).body.addresses[0]
      .id as string;
    return { a, b, va, vb, orderA, detailA, addrId };
  }

  it('another business cannot read, list, search or export a business’s orders and customers', async () => {
    const { b, orderA } = await pair();
    expect((await b.api.get(`/v1/orders/${orderA.id}`)).status).toBe(404);
    expect((await b.api.get(`/v1/orders/${orderA.id}/duplicates`)).status).toBe(404);
    expect((await b.api.get(`/v1/customers/${orderA.customer.id}`)).status).toBe(404);
    expect((await b.api.get(`/v1/customers/${orderA.customer.id}/orders`)).status).toBe(404);
    expect((await b.api.get('/v1/orders')).body).toMatchObject({ total: 0, items: [] });
    expect((await b.api.get('/v1/customers')).body.items).toEqual([]);
    expect((await b.api.get(`/v1/orders?q=${orderA.orderNumber}`)).body.total).toBe(0);
    expect((await b.api.get('/v1/orders?q=rina')).body.total).toBe(0);
    expect((await b.api.get(`/v1/orders?customerId=${orderA.customer.id}`)).body.total).toBe(0);
    const csv = (await b.api.get('/v1/exports/orders').expect(200)).body;
    expect(csv.rowCount).toBe(0);
    expect(csv.csv).not.toContain('Rina');
  });

  it('another business cannot change, cancel, ship or edit an order by its id, and nothing changes', async () => {
    const { a, b, va, orderA } = await pair();
    expect(
      (await status(b.api, orderA.id, 'cancelled', { reason: 'Malicious cancel' })).status,
    ).toBe(404);
    expect((await status(b.api, orderA.id, 'ready_to_ship')).status).toBe(404);
    expect((await b.api.patch(`/v1/orders/${orderA.id}`, { notes: 'hacked' })).status).toBe(404);
    const bulk = (
      await b.api
        .post('/v1/orders/bulk-status', {
          orderIds: [orderA.id],
          status: 'cancelled',
          reason: 'Malicious bulk cancel',
        })
        .expect(200)
    ).body;
    expect(bulk).toMatchObject({
      succeeded: 0,
      failed: 1,
      results: [{ ok: false, orderNumber: null, error: { code: 'not_found' } }],
    });
    const after = (await a.api.get(`/v1/orders/${orderA.id}`)).body;
    expect(after).toMatchObject({ status: 'confirmed', notes: null, stockHeld: true });
    expect(await level(a.api, va.id)).toMatchObject({ reserved: 2 });
    expect(after.history).toHaveLength(2);
  });

  it('another business cannot attach its orders to this one’s customers, addresses or items', async () => {
    const { a, b, va, vb, orderA, addrId } = await pair();
    const items = [{ variantId: vb.id, quantity: 1 }];
    // A's customer and address ids, B's own product
    expect(
      (
        await b.api.post('/v1/orders', {
          customerId: orderA.customer.id,
          addressId: addrId,
          items,
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(400);
    // B's customer, but A's address
    const cb = (
      await b.api.post('/v1/customers', { name: 'B Customer', phone: '01955555555' }).expect(201)
    ).body;
    expect(
      (
        await b.api.post('/v1/orders', {
          customerId: cb.id,
          addressId: addrId,
          items,
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(400);
    // A's product in B's order
    expect((await b.api.post('/v1/orders', body([{ variantId: va.id, quantity: 1 }]))).status).toBe(
      400,
    );
    expect(
      (await b.api.patch(`/v1/customers/${orderA.customer.id}`, { notes: 'hacked' })).status,
    ).toBe(404);
    expect(
      (await b.api.post(`/v1/customers/${orderA.customer.id}/addresses`, address())).status,
    ).toBe(404);
    expect(
      (
        await b.api.patch(`/v1/customers/${orderA.customer.id}/addresses/${addrId}`, {
          line1: 'hacked',
        })
      ).status,
    ).toBe(404);
    expect(
      (await b.api.del(`/v1/customers/${orderA.customer.id}/addresses/${addrId}`)).status,
    ).toBe(404);
    const stillThere = (await a.api.get(`/v1/customers/${orderA.customer.id}`)).body;
    expect(stillThere.addresses).toHaveLength(1);
    expect(stillThere.notes).toBeNull();
  });

  it('the same phone number in two businesses is two customers, and the same key two orders', async () => {
    const a = await shop();
    const b = await shop();
    const va = await item(a.owner, 5);
    const vb = await item(b.owner, 5);
    const shared = key('same');
    const oa = (
      await a.api
        .post('/v1/orders', body([{ variantId: va.id, quantity: 1 }], { idempotencyKey: shared }))
        .expect(201)
    ).body;
    const ob = (
      await b.api
        .post('/v1/orders', body([{ variantId: vb.id, quantity: 1 }], { idempotencyKey: shared }))
        .expect(201)
    ).body;
    expect(oa.customer.id).not.toBe(ob.customer.id);
    expect(oa.orderNumber).toBe(ob.orderNumber); // each business counts from 1001
    expect((await a.api.get('/v1/customers')).body.items).toHaveLength(1);
  });

  it('even with the database in hand, a business’s context sees only its own order rows', async () => {
    const { a, b, orderA } = await pair();
    const own = await t.db.withContext({ tenantId: a.owner.tenant.id }, (tx) => tx.order.count());
    const foreign = await t.db.withContext({ tenantId: b.owner.tenant.id }, (tx) =>
      tx.order.findMany({ where: { id: orderA.id } }),
    );
    expect(own).toBe(1);
    expect(foreign).toEqual([]);
    expect(
      await t.db.withContext({ tenantId: b.owner.tenant.id }, (tx) =>
        tx.orderStatusHistory.count({ where: { orderId: orderA.id } }),
      ),
    ).toBe(0);
    expect(await t.db.withContext({}, (tx) => tx.order.count())).toBe(0); // no business set: nothing at all
    await expect(
      t.db.withContext(
        { tenantId: b.owner.tenant.id },
        (tx) =>
          tx.$executeRaw`INSERT INTO orders (id, tenant_id, order_number, customer_id, ship_name, ship_phone, ship_line1, ship_area, ship_district, ship_division, subtotal_minor, total_minor, cod_amount_minor, updated_at)
          VALUES (gen_random_uuid(), ${a.owner.tenant.id}::uuid, 999, ${orderA.customer.id}::uuid, 'x', 'x', 'x', 'x', 'x', 'x', 0, 0, 0, now())`,
      ),
    ).rejects.toThrow();
  });
});

describe('who may do what with orders', () => {
  it('staff and managers handle orders; an accountant can only look', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10);
    const o = await make(api, [{ variantId: v.id, quantity: 1 }]);
    const staff = await addMember(t, owner, 'STAFF');
    const manager = await addMember(t, owner, 'MANAGER');
    const acct = await addMember(t, owner, 'ACCOUNTANT');
    for (const who of [staff, manager]) {
      const c = call(who);
      expect((await c.get('/v1/orders')).status).toBe(200);
      const made = await c.post(
        '/v1/orders',
        body([{ variantId: v.id, quantity: 1 }], {
          customer: { name: 'By Staff', phone: newPhone() },
        }),
      );
      expect(made.status).toBe(201);
      expect((await status(c, made.body.id, 'confirmed')).status).toBe(200);
      expect((await c.patch(`/v1/orders/${made.body.id}`, { notes: 'fine' })).status).toBe(200);
      expect(
        (await c.post('/v1/customers', { name: 'New Person', phone: newPhone() })).status,
      ).toBe(201);
    }
    const ac = call(acct);
    for (const path of [
      '/v1/orders',
      `/v1/orders/${o.id}`,
      '/v1/customers',
      `/v1/customers/${o.customer.id}`,
      '/v1/exports/orders',
      `/v1/orders/${o.id}/duplicates`,
    ])
      expect((await ac.get(path)).status, path).toBe(200);
    expect((await ac.post('/v1/orders/duplicate-check', { phone: '01712345678' })).status).toBe(
      200,
    );
    expect((await ac.post('/v1/orders', body([{ variantId: v.id, quantity: 1 }]))).status).toBe(
      403,
    );
    expect((await status(ac, o.id, 'confirmed')).status).toBe(403);
    expect((await ac.patch(`/v1/orders/${o.id}`, { notes: 'no' })).status).toBe(403);
    expect(
      (await ac.post('/v1/orders/bulk-status', { orderIds: [o.id], status: 'confirmed' })).status,
    ).toBe(403);
    expect((await ac.post('/v1/customers', { name: 'Nope', phone: newPhone() })).status).toBe(403);
    expect((await ac.patch(`/v1/customers/${o.customer.id}`, { notes: 'no' })).status).toBe(403);
    expect((await api.get(`/v1/orders/${o.id}`)).body.status).toBe('pending_confirmation');
  });
});

describe('PROPERTY: orders and inventory always agree', () => {
  type Op = { kind: 'create'; qty: number } | { kind: 'move'; pick: number; to: OrderStatus };

  const TARGETS: OrderStatus[] = [
    'confirmed',
    'ready_to_ship',
    'shipped',
    'in_transit',
    'delivered',
    'delivery_failed',
    'cancelled',
    'return_requested',
    'returned',
    'pending_confirmation',
  ];
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    {
      weight: 2,
      arbitrary: fc.integer({ min: 1, max: 6 }).map((qty): Op => ({ kind: 'create', qty })),
    },
    {
      weight: 8,
      arbitrary: fc
        .tuple(fc.nat(1000), fc.constantFrom(...TARGETS))
        .map(([pick, to]): Op => ({ kind: 'move', pick, to })),
    },
  );

  it('for random sequences of creations and status changes, the real system matches the pure rules, and the stock books balance', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 6, maxLength: 28 }), async (ops) => {
        const { owner, api } = await shop();
        const INITIAL = 10;
        const v = await item(owner, INITIAL);
        // model
        const orders: { id: string; qty: number; status: OrderStatus }[] = [];
        let onHand = INITIAL;
        let reserved = 0;
        let seq2 = 0;

        for (const op of ops) {
          if (op.kind === 'create') {
            const r = await api.post(
              '/v1/orders',
              body([{ variantId: v.id, quantity: op.qty }], {
                customer: { name: `Buyer ${++seq2}`, phone: newPhone() },
              }),
            );
            expect(r.status).toBe(201);
            orders.push({ id: r.body.id, qty: op.qty, status: 'pending_confirmation' });
            continue;
          }
          if (orders.length === 0) continue;
          const o = orders[op.pick % orders.length]!;
          const reason = { reason: 'property test reason' };
          const res = await status(api, o.id, op.to, reason);

          if (o.status === op.to) {
            expect(res.status).toBe(200); // repeating is harmless
            continue;
          }
          if (!canTransition(o.status, op.to)) {
            expect(res.status, `${o.status} -> ${op.to}`).toBe(409);
            expect(res.body.code).toBe('invalid_transition');
            continue;
          }
          const effect = stockEffect(o.status, op.to);
          if (effect === 'reserve' && onHand - reserved < o.qty) {
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('insufficient_stock');
            continue;
          }
          expect(res.status, `${o.status} -> ${op.to}: ${JSON.stringify(res.body)}`).toBe(200);
          if (effect === 'reserve') reserved += o.qty;
          if (effect === 'release') reserved -= o.qty;
          if (effect === 'ship') {
            reserved -= o.qty;
            onHand -= o.qty;
          }
          if (effect === 'restock') onHand += o.qty;
          o.status = op.to;

          const lv = await level(api, v.id);
          expect({ onHand: lv.onHand, reserved: lv.reserved }).toEqual({ onHand, reserved });
          expect(lv.available).toBeGreaterThanOrEqual(0);
        }

        // what the API says matches the model, order by order
        for (const o of orders) {
          const d = (await api.get(`/v1/orders/${o.id}`)).body;
          expect(d.status).toBe(o.status);
          expect(d.stockHeld).toBe(holdsStock(o.status));
          // the history is a chain: each row starts where the previous one ended
          let at: string | null = null;
          for (const h of d.history as { fromStatus: string | null; toStatus: string }[]) {
            expect(h.fromStatus).toBe(at);
            at = h.toStatus;
          }
          expect(at).toBe(o.status);
        }
        // units reserved are exactly the units of orders holding stock; ledger totals equal the level
        const held = orders.filter((o) => holdsStock(o.status)).reduce((n, o) => n + o.qty, 0);
        const lv = await level(api, v.id);
        expect(lv.reserved).toBe(held);
        const ledger = (await api.get(`/v1/inventory/movements?variantId=${v.id}&limit=100`)).body
          .items as {
          onHandDelta: number;
          reservedDelta: number;
          damagedDelta: number;
        }[];
        expect(ledger.reduce((n, m) => n + m.onHandDelta, 0)).toBe(lv.onHand);
        expect(ledger.reduce((n, m) => n + m.reservedDelta, 0)).toBe(lv.reserved);
        // nothing is ever created or lost: stock on hand plus what shipped and is still out equals what came in
        const out = orders
          .filter((o) =>
            ['shipped', 'in_transit', 'delivered', 'delivery_failed', 'return_requested'].includes(
              o.status,
            ),
          )
          .reduce((n, o) => n + o.qty, 0);
        expect(lv.onHand + out).toBe(INITIAL);
      }),
      { numRuns: Number(process.env.PROPERTY_RUNS ?? 12) },
    );
  }, 120_000);
});
