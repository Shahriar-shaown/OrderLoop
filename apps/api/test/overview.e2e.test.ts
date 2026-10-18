import { fakeNetwork } from '@orderloop/courier-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createTestApp, registerTenant, type TestApp } from './app.js';

let t: TestApp;
let net = fakeNetwork({});
let consignment = 5000;
beforeAll(async () => {
  t = await createTestApp(
    {},
    {
      courier: {
        fetch: (url: string, init: unknown) =>
          (net.fetch as never as (u: string, i: unknown) => unknown)(url, init),
        sleep: async () => undefined,
      },
    },
  );
});
afterAll(() => t.close());

type Who = { accessToken: string };
let seq = 0;
const key = (p = 'k') => `${p}-${Date.now()}-${++seq}`;
let phoneSeq = 800;
const call = (who: Who) => ({
  get: (path: string) => t.http.get(path).set(bearer(who.accessToken)),
  post: (path: string, body: object = {}) =>
    t.http.post(path).set(bearer(who.accessToken)).send(body),
});
type Api = ReturnType<typeof call>;

const TOKEN = 'steadfast-token-0123456789';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

/** A business connected to Steadfast (against a fake network: nothing real is contacted). */
async function shop() {
  net = fakeNetwork({
    'POST /api/v1/create_order': (rec) => {
      const id = ++consignment;
      return {
        body: {
          status: 200,
          consignment: {
            consignment_id: id,
            invoice: (rec.body as { invoice: string }).invoice,
            tracking_code: `TRK${id}`,
            status: 'in_review',
          },
        },
      };
    },
  });
  const owner = await registerTenant(t);
  const api = call(owner);
  const saved = await api
    .post('/v1/couriers/steadfast/test') // not connected yet: just proves the route exists
    .then(() => null);
  void saved;
  const res = await t.http
    .patch('/v1/couriers/steadfast')
    .set(bearer(owner.accessToken))
    .send({
      environment: 'production',
      credentials: { apiKey: 'k', secretKey: 's' },
      webhookSecret: TOKEN,
    })
    .expect(200);
  const hookPath = new URL(res.body.connection.webhookUrl as string).pathname;
  return { owner, api, hookPath, tenantId: owner.tenant.id };
}

interface Booked {
  id: string;
  number: number;
  consignmentId: string;
  shipmentId: string;
  variantId: string;
}

/** An order booked with the courier. `price` is in paisa; COD = price + 6000 delivery charge. */
async function booked(
  owner: Who,
  api: Api,
  opts: { price?: number; cost?: number } = {},
): Promise<Booked> {
  const p = await t.http
    .post('/v1/products')
    .set(bearer(owner.accessToken))
    .send({
      name: `Tee ${++seq}`,
      variants: [
        {
          sku: `FIN-${Date.now()}-${seq}`,
          priceMinor: opts.price ?? 100_000,
          ...(opts.cost !== undefined ? { costMinor: opts.cost } : {}),
        },
      ],
    })
    .expect(201);
  const variantId = p.body.variants[0].id as string;
  await api.post('/v1/inventory/receive', { variantId, quantity: 50 }).expect(201);
  const order = await api
    .post('/v1/orders', {
      customer: { name: 'Rina Akter', phone: `0171${String(1000000 + ++phoneSeq).slice(-7)}` },
      address: {
        recipientName: 'Rina Akter',
        phone: '01712345678',
        line1: 'House 5, Road 3',
        area: 'Dhanmondi',
        district: 'Dhaka',
        division: 'Dhaka',
      },
      items: [{ variantId, quantity: 1 }],
      deliveryChargeMinor: 6_000,
      idempotencyKey: key('ord'),
      confirm: true,
    })
    .expect(201);
  await api.post(`/v1/orders/${order.body.id}/status`, { status: 'ready_to_ship' }).expect(200);
  const s = await api
    .post(`/v1/orders/${order.body.id}/shipments`, {
      provider: 'steadfast',
      idempotencyKey: key('bk'),
    })
    .expect(201);
  expect(s.body.status).toBe('booked');
  return {
    id: order.body.id,
    number: order.body.orderNumber,
    consignmentId: s.body.consignmentId,
    shipmentId: s.body.id,
    variantId,
  };
}

/** The courier says the parcel was delivered (a real webhook, with the real secret). */
const deliver = (hookPath: string, b: Booked, cod = 106_000) =>
  t.http
    .post(hookPath)
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({
      notification_type: 'delivery_status',
      consignment_id: Number(b.consignmentId),
      invoice: `OL-${b.number}`,
      cod_amount: cod / 100,
      status: 'delivered',
      delivery_charge: 60,
      tracking_message: 'Delivered',
      updated_at: '2026-10-18 10:00:00',
    })
    .expect(200);

const HEAD =
  'transaction_id,consignment_id,tracking_code,reference,phone,date,type,collected,delivery_charge,cod_fee,return_charge,other_deduction,net,note';
const file = (...lines: string[]) => [HEAD, ...lines].join('\n');
const importFile = (api: Api, csv: string) =>
  api.post('/v1/settlements/import', { provider: 'steadfast', csv, fileName: 's.csv' });

describe('what the screens read: orders, cash, shipments, inventory, analytics', () => {
  it('orders say what is in them, who has the parcel and where the cash stands, and count each status', async () => {
    const { owner, api, hookPath } = await shop();
    const d = today();
    const a = await booked(owner, api, { cost: 60_000 }); // delivered, then paid in full
    const b = await booked(owner, api, { cost: 60_000 }); // delivered, nothing reported
    const c = await booked(owner, api, { cost: 60_000 }); // delivered, part reported
    const e = await booked(owner, api, { cost: 60_000 }); // still with the courier
    for (const x of [a, b, c]) await deliver(hookPath, x);
    await importFile(
      api,
      file(
        `,${a.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`,
        `,${c.consignmentId},,,,${d},cod,400,0,0,0,0,,`,
      ),
    ).expect(200);

    const list = (await api.get('/v1/orders?limit=50').expect(200)).body;
    const by = (n: number) => list.items.find((o: { orderNumber: number }) => o.orderNumber === n);
    expect(by(a.number)).toMatchObject({
      payment: 'cod_collected',
      courier: { provider: 'steadfast', simulated: false, status: 'delivered' },
    });
    expect(by(b.number).payment).toBe('cod_unpaid'); // delivered is not paid
    expect(by(c.number).payment).toBe('cod_partial');
    expect(by(e.number).payment).toBe('cod_pending');
    expect(by(a.number).itemsSummary).toMatch(/^Tee \d+ ×1$/);
    // chips count every status for the same search, whatever status is selected
    expect(list.statusCounts).toMatchObject({ delivered: 3, ready_to_ship: 1 });
    const onlyDelivered = (await api.get('/v1/orders?status=delivered').expect(200)).body;
    expect(onlyDelivered.items).toHaveLength(3);
    expect(onlyDelivered.statusCounts).toMatchObject({ delivered: 3, ready_to_ship: 1 });

    const cash = (await api.get(`/v1/orders/${a.id}/cash`).expect(200)).body;
    expect(cash).toMatchObject({
      state: 'paid',
      expectedMinor: 106_000,
      collectedMinor: 106_000,
      chargesMinor: 7_060,
      netMinor: 98_940,
      outstandingMinor: 0,
      hasCourierShipment: true,
      lines: 1,
    });
    expect((await api.get(`/v1/orders/${b.id}/cash`).expect(200)).body).toMatchObject({
      state: 'unpaid',
      collectedMinor: 0,
      outstandingMinor: 106_000,
    });
    expect((await api.get(`/v1/orders/${c.id}/cash`).expect(200)).body).toMatchObject({
      state: 'partial',
      outstandingMinor: 66_000,
    });
    const accountant = await addMember(t, owner, 'ACCOUNTANT');
    expect((await call(accountant).get(`/v1/orders/${a.id}/cash`)).status).toBe(200);
    const staff = await addMember(t, owner, 'STAFF');
    expect((await call(staff).get(`/v1/orders/${a.id}/cash`)).status).toBe(403);
    expect((await call(staff).get('/v1/orders')).status).toBe(200);

    // a statement's figures: what its orders were owed against what it reports
    const batches = (await api.get('/v1/settlements/batches').expect(200)).body;
    expect(batches[0]).toMatchObject({
      expectedMinor: 2 * 106_000,
      differenceMinor: 106_000 + 40_000 - 2 * 106_000,
    });
  });

  it('shipments list and courier figures count real and simulated parcels apart', async () => {
    const { owner, api, hookPath } = await shop();
    await t.http.patch('/v1/couriers/mock').set(bearer(owner.accessToken)).send({}).expect(200);
    const x = await booked(owner, api);
    const y = await booked(owner, api);
    await deliver(hookPath, x);
    // a simulated parcel on its way
    const sim = await t.http
      .post('/v1/products')
      .set(bearer(owner.accessToken))
      .send({ name: 'Sim tee', variants: [{ sku: `SIM-${Date.now()}`, priceMinor: 50_000 }] })
      .expect(201);
    await api
      .post('/v1/inventory/receive', { variantId: sim.body.variants[0].id, quantity: 5 })
      .expect(201);
    const so = await api
      .post('/v1/orders', {
        customer: { name: 'S S', phone: '01755555555' },
        address: {
          recipientName: 'S S',
          phone: '01755555555',
          line1: 'House 1, Road 1',
          area: 'Gulshan',
          district: 'Dhaka',
          division: 'Dhaka',
        },
        items: [{ variantId: sim.body.variants[0].id, quantity: 1 }],
        idempotencyKey: key('o'),
        confirm: true,
      })
      .expect(201);
    await api.post(`/v1/orders/${so.body.id}/status`, { status: 'ready_to_ship' }).expect(200);
    const ss = await api
      .post(`/v1/orders/${so.body.id}/shipments`, { provider: 'mock', idempotencyKey: key('b') })
      .expect(201);
    await api.post(`/v1/shipments/${ss.body.id}/simulate`, { event: 'in_transit' }).expect(200);

    const all = (await api.get('/v1/shipments').expect(200)).body;
    expect(all.total).toBe(3);
    expect(all.statusCounts).toMatchObject({ booked: 1, delivered: 1, in_transit: 1 });
    expect(all.items.map((r: { orderNumber: number }) => r.orderNumber).sort()).toEqual(
      [x.number, y.number, so.body.orderNumber].sort(),
    );
    const filtered = (await api.get('/v1/shipments?status=delivered').expect(200)).body;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.statusCounts).toMatchObject({ booked: 1, in_transit: 1 }); // counts ignore the status filter
    expect((await api.get(`/v1/shipments?q=OL-${y.number}`).expect(200)).body.items).toHaveLength(
      1,
    );
    expect((await api.get('/v1/shipments?provider=mock').expect(200)).body.items[0].simulated).toBe(
      true,
    );
    expect((await api.get('/v1/shipments?limit=2&page=2').expect(200)).body.items).toHaveLength(1);

    const stats = (await api.get('/v1/shipment-stats').expect(200)).body;
    expect(stats).toMatchObject({
      bookedToday: 3,
      awaitingPickup: 1,
      onTheWay: 1,
      delivered: 1,
      codOnTheWayMinor: 0,
    }); // the parcel on the way is simulated: no real money
    const steadfast = stats.providers.find((p: { provider: string }) => p.provider === 'steadfast');
    expect(steadfast).toMatchObject({
      shipments: 2,
      delivered: 1,
      deliveredRate: 1,
      simulated: false,
    });
    expect(stats.providers.find((p: { provider: string }) => p.provider === 'mock').simulated).toBe(
      true,
    );
    const staff = await addMember(t, owner, 'STAFF');
    expect((await call(staff).get('/v1/shipments')).status).toBe(200);
  });

  it('inventory value is worked out at cost and at retail, and says what has no cost', async () => {
    const { owner, api } = await shop();
    const mk = async (
      name: string,
      price: number,
      cost: number | null,
      qty: number,
      reorder = 0,
    ) => {
      const p = await t.http
        .post('/v1/products')
        .set(bearer(owner.accessToken))
        .send({
          name,
          variants: [
            {
              sku: `${name}-${Date.now()}-${++seq}`,
              priceMinor: price,
              ...(cost !== null ? { costMinor: cost } : {}),
              reorderPoint: reorder,
            },
          ],
        })
        .expect(201);
      if (qty > 0)
        await api
          .post('/v1/inventory/receive', { variantId: p.body.variants[0].id, quantity: qty })
          .expect(201);
    };
    await mk('A', 100_000, 60_000, 10); // cost 600,000 retail 1,000,000
    await mk('B', 50_000, 20_000, 3, 5); // low stock; cost 60,000 retail 150,000
    await mk('C', 30_000, null, 4); // no cost: left out of the cost value
    await mk('D', 20_000, 10_000, 0); // out of stock
    expect((await api.get('/v1/inventory/summary').expect(200)).body).toEqual({
      products: 4,
      variants: 4,
      inventoryValueCostMinor: 660_000,
      retailValueMinor: 1_000_000 + 150_000 + 120_000,
      missingCostVariants: 1,
      lowStockCount: 1,
      outOfStockCount: 1,
    });
  });

  it('analytics gives daily revenue and gross profit, channels and best sellers, and withholds profit it cannot know', async () => {
    const { owner, api, hookPath } = await shop();
    const d = today();
    const costed = await booked(owner, api, { cost: 60_000 });
    const uncosted = await booked(owner, api);
    await deliver(hookPath, costed);
    const before = (await api.get(`/v1/finance/analytics?from=${d}&to=${d}`).expect(200)).body;
    expect(before.daily).toHaveLength(1);
    expect(before.daily[0]).toMatchObject({
      date: d,
      revenueMinor: 106_000,
      grossProfitMinor: 46_000,
    }); // 1060 - cost 600 (delivery billed counts as revenue)
    await deliver(hookPath, uncosted);
    const a = (await api.get(`/v1/finance/analytics?from=${d}&to=${d}`).expect(200)).body;
    expect(a.daily[0]).toMatchObject({ revenueMinor: 212_000, grossProfitMinor: null }); // one line has no cost: unknown, not zero
    expect(a).toMatchObject({
      deliveredOrders: 2,
      placedOrders: 2,
      linesWithoutCost: 1,
      averageOrderMinor: 106_000,
      deliverySuccessRate: 1,
      notDeliveredMinor: 0,
      totalCostMinor: null,
    });
    expect(a.channels).toEqual([{ source: 'other', orders: 2, revenueMinor: 212_000 }]);
    expect(a.topProducts).toHaveLength(2);
    expect(
      a.topProducts.find((p: { costMinor: number | null }) => p.costMinor === null)
        .grossProfitMinor,
    ).toBeNull();
    expect(
      (await api.get(`/v1/finance/analytics?from=${d}&to=${d}&source=facebook`).expect(200)).body
        .deliveredOrders,
    ).toBe(0);
    expect((await api.get('/v1/finance/analytics?from=2026-10-10&to=2026-10-01')).status).toBe(400);
    // the finance summary also says how recorded costs split
    await api
      .post('/v1/finance/costs', {
        kind: 'advertising',
        amountMinor: 24_000,
        incurredOn: d,
        note: 'Boost',
        idempotencyKey: key(),
      })
      .expect(201);
    await api
      .post('/v1/finance/costs', {
        kind: 'packaging',
        amountMinor: 4_000,
        incurredOn: d,
        note: 'Boxes',
        idempotencyKey: key(),
      })
      .expect(201);
    const s = (await api.get(`/v1/finance/summary?from=${d}&to=${d}`).expect(200)).body;
    expect(
      [...s.manualCostsByKind].sort((x: { kind: string }, y: { kind: string }) =>
        x.kind.localeCompare(y.kind),
      ),
    ).toEqual([
      { kind: 'advertising', amountMinor: 24_000 },
      { kind: 'packaging', amountMinor: 4_000 },
    ]);
  });
});
