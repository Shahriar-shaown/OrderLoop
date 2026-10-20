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

type Who = { accessToken: string; tenant: { id: string } };
let seq = 0;
const key = () => `dash-${Date.now()}-${++seq}`;
let phoneSeq = 9000;
const phone = () => `0171${String(1000000 + ++phoneSeq).slice(-7)}`;
const call = (who: Who) => ({
  get: (p: string) => t.http.get(p).set(bearer(who.accessToken)),
  post: (p: string, b: object = {}) => t.http.post(p).set(bearer(who.accessToken)).send(b),
  patch: (p: string, b: object) => t.http.patch(p).set(bearer(who.accessToken)).send(b),
});
type Api = ReturnType<typeof call>;

const shop = async () => {
  const owner = await registerTenant(t);
  return { owner, api: call(owner) };
};
async function item(
  owner: Who,
  stock: number,
  o: { price?: number; cost?: number | null; reorder?: number } = {},
) {
  const { variant } = await createProduct(t, owner.accessToken, {
    priceMinor: o.price ?? 100_000,
    reorderPoint: o.reorder ?? 0,
  });
  if (o.cost !== undefined && o.cost !== null)
    await call(owner).patch(`/v1/variants/${variant.id}`, { costMinor: o.cost }).expect(200);
  if (stock > 0)
    await call(owner)
      .post('/v1/inventory/receive', { variantId: variant.id, quantity: stock })
      .expect(201);
  return variant as { id: string; sku: string };
}
const order = async (api: Api, items: object[], extra: object = {}) =>
  (
    await api
      .post('/v1/orders', {
        customer: { name: 'Dash Buyer', phone: phone() },
        address: {
          recipientName: 'Dash Buyer',
          phone: '01712345678',
          line1: 'Road 1',
          area: 'Sadar',
          district: 'Dhaka',
          division: 'Dhaka',
        },
        items,
        idempotencyKey: key(),
        ...extra,
      })
      .expect(201)
  ).body as { id: string; totalMinor: number };
const move = (api: Api, id: string, to: string, reason = 'dashboard test') =>
  api.post(`/v1/orders/${id}/status`, { status: to, reason }).expect(200);
const deliver = async (api: Api, id: string) => {
  for (const s of ['confirmed', 'ready_to_ship', 'shipped', 'in_transit', 'delivered'])
    await move(api, id, s);
};
const dash = async (api: Api, period = '7d') =>
  (await api.get(`/v1/dashboard?period=${period}`).expect(200)).body;
const dayIn = (tz: string, d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: tz });

describe('dashboard figures come from the backend', () => {
  it('an empty business shows zeros, a full calendar of days, and says why there is no profit', async () => {
    const { api } = await shop();
    for (const [period, days] of [
      ['today', 1],
      ['7d', 7],
      ['30d', 30],
    ] as const) {
      const d = await dash(api, period);
      expect(d.period).toBe(period);
      expect(d.daily).toHaveLength(days);
      expect(d.to).toBe(dayIn('Asia/Dhaka'));
      expect(d.timezone).toBe('Asia/Dhaka');
      expect(d.orders.total).toBe(0);
      expect(Object.keys(d.orders.byStatus).sort()).toEqual([
        'cancelled',
        'confirmed',
        'delivered',
        'delivery_failed',
        'in_transit',
        'pending_confirmation',
        'ready_to_ship',
        'return_requested',
        'returned',
        'shipped',
      ]);
      expect(Object.values(d.orders.byStatus).every((n) => n === 0)).toBe(true);
      expect(d.sales).toMatchObject({
        orderedMinor: 0,
        deliveredMinor: 0,
        codOutForDeliveryMinor: 0,
        ordersCounted: 0,
        averageOrderMinor: null,
      });
      expect(d.delivery).toMatchObject({
        inProgress: 0,
        delivered: 0,
        failed: 0,
        successRate: null,
      });
      expect(d.lowStock).toEqual({ count: 0, items: [] });
      expect(d.recentActivity).toEqual([]);
      expect(d.profit).toMatchObject({ available: false, lines: 0 });
      expect(d.profit.reason).toMatch(/No delivered orders/);
    }
  });

  it('counts orders by status and adds up sales, delivery and cash on delivery', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 100, { price: 100_000 });
    const pending = await order(api, [{ variantId: v.id, quantity: 1 }]); // 1000
    const confirmed = await order(api, [{ variantId: v.id, quantity: 2 }], {
      deliveryChargeMinor: 6_000,
    }); // 2060
    const shipped = await order(api, [{ variantId: v.id, quantity: 3 }], {
      advancePaidMinor: 50_000,
    }); // 3000, cod 2500
    const done = await order(api, [{ variantId: v.id, quantity: 4 }]); // 4000
    const cancelled = await order(api, [{ variantId: v.id, quantity: 5 }]); // 5000, excluded from sales
    const failed = await order(api, [{ variantId: v.id, quantity: 1 }]); // 1000
    await move(api, confirmed.id, 'confirmed');
    for (const s of ['confirmed', 'ready_to_ship', 'shipped']) await move(api, shipped.id, s);
    await deliver(api, done.id);
    await move(api, cancelled.id, 'cancelled', 'Customer cancelled');
    for (const s of ['confirmed', 'ready_to_ship', 'shipped', 'in_transit'])
      await move(api, failed.id, s);
    await move(api, failed.id, 'delivery_failed', 'Not at home');

    const d = await dash(api, '7d');
    expect(d.orders.total).toBe(6);
    expect(d.orders.byStatus).toMatchObject({
      pending_confirmation: 1,
      confirmed: 1,
      shipped: 1,
      delivered: 1,
      cancelled: 1,
      delivery_failed: 1,
      ready_to_ship: 0,
      in_transit: 0,
    });
    const counted = [pending, confirmed, shipped, done, failed].reduce(
      (n, o) => n + o.totalMinor,
      0,
    ); // not the cancelled one
    expect(d.sales).toMatchObject({
      orderedMinor: counted,
      ordersCounted: 5,
      averageOrderMinor: Math.round(counted / 5),
      deliveredMinor: done.totalMinor,
      codOutForDeliveryMinor: shipped.totalMinor - 50_000,
    });
    expect(d.delivery).toMatchObject({
      inProgress: 1,
      delivered: 1,
      failed: 1,
      returnsOpen: 0,
      returned: 0,
      successRate: 0.5,
    });
    // the daily series adds up to the same figures, with today carrying everything
    expect(d.daily.reduce((n: number, x: { orders: number }) => n + x.orders, 0)).toBe(5);
    expect(d.daily.reduce((n: number, x: { orderedMinor: number }) => n + x.orderedMinor, 0)).toBe(
      counted,
    );
    expect(d.daily.at(-1)).toMatchObject({
      date: dayIn('Asia/Dhaka'),
      orders: 5,
      orderedMinor: counted,
    });
  });

  it('returns and open return requests are counted separately, and success rate counts returns as not delivered', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 20);
    const a = await order(api, [{ variantId: v.id, quantity: 1 }]);
    const b = await order(api, [{ variantId: v.id, quantity: 1 }]);
    const c = await order(api, [{ variantId: v.id, quantity: 1 }]);
    for (const id of [a.id, b.id, c.id]) await deliver(api, id);
    await move(api, b.id, 'return_requested', 'Wrong size');
    await move(api, c.id, 'return_requested', 'Damaged');
    await move(api, c.id, 'returned', 'Received');
    const d = await dash(api);
    expect(d.delivery).toMatchObject({
      delivered: 1,
      returnsOpen: 1,
      returned: 1,
      successRate: 0.5,
    });
  });

  it('counts orders by the day they were created in the business’s own time zone', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 20);
    const today = await order(api, [{ variantId: v.id, quantity: 1 }]);
    const yesterday = await order(api, [{ variantId: v.id, quantity: 1 }]);
    const lastMonth = await order(api, [{ variantId: v.id, quantity: 1 }]);
    const tenantId = owner.tenant.id;
    const back = (id: string, interval: string) =>
      t.db.withContext({ tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE orders SET created_at = now() - interval '${interval}' WHERE id = '${id}'`,
        ),
      );
    await back(yesterday.id, '30 hours');
    await back(lastMonth.id, '20 days');
    expect((await dash(api, 'today')).orders.total).toBe(1);
    expect((await dash(api, '7d')).orders.total).toBe(2);
    const month = await dash(api, '30d');
    expect(month.orders.total).toBe(3);
    expect(month.daily).toHaveLength(30);
    expect(month.daily.filter((x: { orders: number }) => x.orders > 0)).toHaveLength(3);
    void today;
  });

  it('“today” is the business’s calendar day, not the UTC day', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 20);
    const o = await order(api, [{ variantId: v.id, quantity: 1 }]);
    // a business far behind UTC: midnight there is hours after UTC midnight
    await api.patch('/v1/tenant', { timezone: 'America/Los_Angeles' }).expect(200);
    const d = await dash(api, 'today');
    expect(d.timezone).toBe('America/Los_Angeles');
    expect(d.to).toBe(dayIn('America/Los_Angeles'));
    // put the order one minute before the start of that local day: it belongs to yesterday there
    const startOfDay = await t.db.withContext(
      { tenantId: owner.tenant.id },
      (tx) =>
        tx.$queryRaw<
          { s: Date }[]
        >`SELECT (date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles')) AT TIME ZONE 'America/Los_Angeles' AS s`,
    );
    await t.db.withContext(
      { tenantId: owner.tenant.id },
      (tx) =>
        tx.$executeRaw`UPDATE orders SET created_at = ${new Date(startOfDay[0]!.s.getTime() - 60_000)} WHERE id = ${o.id}::uuid`,
    );
    expect((await dash(api, 'today')).orders.total).toBe(0);
    expect((await dash(api, '7d')).orders.total).toBe(1);
  });
});

describe('work waiting for a person', () => {
  it('counts every open order, not just those created in the period', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 50);
    const stale = await order(api, [{ variantId: v.id, quantity: 1 }]); // pending, forgotten for weeks
    const toShip = await order(api, [{ variantId: v.id, quantity: 1 }]);
    const failed = await order(api, [{ variantId: v.id, quantity: 1 }]);
    const returning = await order(api, [{ variantId: v.id, quantity: 1 }]);
    await move(api, toShip.id, 'confirmed');
    for (const s of ['confirmed', 'ready_to_ship', 'shipped', 'in_transit', 'delivery_failed'])
      await move(api, failed.id, s);
    for (const s of [
      'confirmed',
      'ready_to_ship',
      'shipped',
      'in_transit',
      'delivered',
      'return_requested',
    ])
      await move(api, returning.id, s);
    for (const o of [stale, toShip, failed, returning])
      await t.db.withContext(
        { tenantId: owner.tenant.id },
        (tx) =>
          tx.$executeRaw`UPDATE orders SET created_at = now() - interval '25 days' WHERE id = ${o.id}::uuid`,
      );
    const today = await dash(api, 'today');
    expect(today.orders.total).toBe(0);
    expect(today.attention).toEqual({
      pendingConfirmation: 1,
      toShip: 1,
      deliveryFailed: 1,
      returnsOpen: 1,
    });
    expect((await dash(api, '30d')).attention).toEqual(today.attention);
  });
});

describe('profit is shown only when it can be worked out', () => {
  it('an estimate from recorded costs, labelled as such, using the cost at the time of sale', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10, { price: 85_000, cost: 40_000 });
    const o = await order(api, [{ variantId: v.id, quantity: 2 }], {
      discountMinor: 10_000,
      deliveryChargeMinor: 6_000,
    });
    await deliver(api, o.id);
    // the cost changing later does not rewrite what was sold
    await api.patch(`/v1/variants/${v.id}`, { costMinor: 99_000 }).expect(200);
    const d = await dash(api);
    expect(d.profit).toMatchObject({
      available: true,
      kind: 'estimate',
      revenueMinor: 166_000, // 2 x 850 - 100 order discount + 60 delivery billed: the one definition of revenue
      costMinor: 80_000,
      grossProfitMinor: 86_000,
      deliveredOrders: 1,
      lines: 1,
    });
    expect(d.profit.basis).toMatch(/Leaves out courier fees/);
  });

  it('is withheld, with the reason, when any delivered line has no cost price', async () => {
    const { owner, api } = await shop();
    const withCost = await item(owner, 10, { price: 85_000, cost: 40_000 });
    const noCost = await item(owner, 10, { price: 50_000 });
    const o = await order(api, [
      { variantId: withCost.id, quantity: 1 },
      { variantId: noCost.id, quantity: 1 },
    ]);
    await deliver(api, o.id);
    const d = await dash(api);
    expect(d.profit).toMatchObject({ available: false, linesWithCost: 1, lines: 2 });
    expect(d.profit.reason).toMatch(/1 of 2 delivered order lines have no cost price/);
    expect(JSON.stringify(d.profit)).not.toMatch(/grossProfit|revenueMinor/);
  });

  it('ignores orders that were not delivered, and dates the rest by delivery', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10, { price: 85_000, cost: 40_000 });
    const pending = await order(api, [{ variantId: v.id, quantity: 1 }]);
    const old = await order(api, [{ variantId: v.id, quantity: 1 }]);
    await deliver(api, old.id);
    await t.db.withContext(
      { tenantId: owner.tenant.id },
      (tx) =>
        tx.$executeRaw`UPDATE orders SET created_at = now() - interval '20 days' WHERE id = ${old.id}::uuid`,
    );
    // the period is dated by delivery (the same as the finance summary), so an old order delivered now counts today
    expect((await dash(api, 'today')).profit).toMatchObject({
      available: true,
      deliveredOrders: 1,
      grossProfitMinor: 45_000,
    });
    void pending;
  });
});

describe('low stock and recent activity', () => {
  it('lists the thinnest items first, counts them all, and leaves out archived ones', async () => {
    const { owner, api } = await shop();
    const none = await item(owner, 0, { reorder: 5 });
    const few = await item(owner, 2, { reorder: 5 });
    const fine = await item(owner, 50, { reorder: 5 });
    const gone = await item(owner, 1, { reorder: 5 });
    await api.patch(`/v1/variants/${gone.id}`, { archived: true }).expect(200);
    const d = await dash(api);
    expect(d.lowStock.count).toBe(2);
    expect(d.lowStock.items.map((i: { variantId: string }) => i.variantId)).toEqual([
      none.id,
      few.id,
    ]);
    expect(d.lowStock.items[0]).toMatchObject({ available: 0, reorderPoint: 5 });
    expect(JSON.stringify(d.lowStock)).not.toContain(fine.id);
    // damaged units are not available
    await api
      .post('/v1/inventory/damage', { variantId: fine.id, quantity: 47, reason: 'flood damage' })
      .expect(201);
    expect((await dash(api)).lowStock.count).toBe(3);
  });

  it('shows only the 5 thinnest but counts all of them', async () => {
    const { owner, api } = await shop();
    for (let i = 0; i < 7; i++) await item(owner, i, { reorder: 10 });
    const d = await dash(api);
    expect(d.lowStock.count).toBe(7);
    expect(d.lowStock.items).toHaveLength(5);
    expect(d.lowStock.items.map((i: { available: number }) => i.available)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('shows the latest status changes with who made them, newest first, at most 12', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 100);
    const staff = await addMember(t, owner, 'STAFF');
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await order(api, [{ variantId: v.id, quantity: 1 }])).id);
    for (const id of ids)
      await call(staff).post(`/v1/orders/${id}/status`, { status: 'confirmed' }).expect(200);
    const d = await dash(api);
    expect(d.recentActivity).toHaveLength(12);
    expect(d.recentActivity[0]).toMatchObject({
      toStatus: 'confirmed',
      fromStatus: 'pending_confirmation',
      actorName: 'Member STAFF',
    });
    const times = d.recentActivity.map((a: { at: string }) => a.at);
    expect(times).toEqual([...times].sort().reverse());
    expect(d.recentActivity.map((a: { orderNumber: number }) => a.orderNumber)[0]).toBe(1008);
  });
});

describe('who can see it, and whose it is', () => {
  it('shows only this business’s figures, and nothing personal', async () => {
    const a = await shop();
    const b = await shop();
    const va = await item(a.owner, 10, { reorder: 50 });
    await order(a.api, [{ variantId: va.id, quantity: 2 }], {
      customer: { name: 'Very Private Name', phone: '01712999000' },
    });
    const forB = await dash(b.api);
    expect(forB.orders.total).toBe(0);
    expect(forB.sales.orderedMinor).toBe(0);
    expect(forB.lowStock.count).toBe(0);
    expect(forB.recentActivity).toEqual([]);
    const forA = await dash(a.api);
    expect(forA.orders.total).toBe(1);
    expect(forA.lowStock.count).toBe(1);
    const text = JSON.stringify(forA);
    expect(text).not.toContain('Very Private Name');
    expect(text).not.toContain('1712999000');
  });

  it('follows a switch of business, and needs a signed-in member who may read orders', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 5);
    await order(api, [{ variantId: v.id, quantity: 1 }]);
    const second = (await api.post('/v1/workspaces', { name: 'Second Shop' }).expect(201)).body;
    const switched = (await api.post('/v1/auth/switch-tenant', { tenantId: second.id }).expect(200))
      .body;
    const inSecond = call({ accessToken: switched.accessToken, tenant: { id: second.id } });
    expect((await dash(inSecond)).orders.total).toBe(0);
    // switching back shows the first business's figures again
    const back = (
      await inSecond.post('/v1/auth/switch-tenant', { tenantId: owner.tenant.id }).expect(200)
    ).body;
    expect(
      (await dash(call({ accessToken: back.accessToken, tenant: owner.tenant }))).orders.total,
    ).toBe(1);
    const acct = await addMember(t, owner, 'ACCOUNTANT');
    const staff = await addMember(t, owner, 'STAFF');
    expect((await call(acct).get('/v1/dashboard')).status).toBe(200);
    expect((await call(staff).get('/v1/dashboard')).status).toBe(200);
    expect((await t.http.get('/v1/dashboard')).status).toBe(401);
  });

  it('withholds cost and profit from roles without finance:read', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10, { price: 85_000, cost: 40_000 });
    await deliver(api, (await order(api, [{ variantId: v.id, quantity: 1 }])).id);
    const staff = await addMember(t, owner, 'STAFF');
    const acct = await addMember(t, owner, 'ACCOUNTANT');
    const forStaff = await dash(call(staff));
    expect(forStaff.profit).toBeNull();
    expect(JSON.stringify(forStaff)).not.toMatch(/grossProfit|costMinor/);
    expect(forStaff.sales.deliveredMinor).toBe(85_000);
    expect((await dash(call(acct))).profit).toMatchObject({ available: true });
  });

  it('refuses an unknown period and uses 7 days by default', async () => {
    const { api } = await shop();
    expect((await api.get('/v1/dashboard?period=year')).status).toBe(400);
    expect((await api.get('/v1/dashboard').expect(200)).body.period).toBe('7d');
  });
});

describe('revenue and profit have one definition everywhere', () => {
  const analytics = async (api: Api, d: string) =>
    (await api.get(`/v1/finance/analytics?from=${d}&to=${d}`).expect(200)).body;
  const summary = async (api: Api, d: string) =>
    (await api.get(`/v1/finance/summary?from=${d}&to=${d}`).expect(200)).body;
  const figure = (s: { figures: { key: string; amountMinor: number }[] }, k: string) =>
    s.figures.find((f) => f.key === k)?.amountMinor ?? 0;
  const cost = (api: Api, kind: string) =>
    api.post('/v1/finance/costs', {
      kind,
      amountMinor: 7_000,
      incurredOn: dayIn('Asia/Dhaka'),
      note: 'test cost',
      idempotencyKey: key(),
    });

  it('the dashboard, finance summary and analytics agree on an order with a discount and a delivery charge', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10, { price: 85_000, cost: 40_000 });
    const o = await order(api, [{ variantId: v.id, quantity: 2 }], {
      discountMinor: 10_000,
      deliveryChargeMinor: 6_000,
    });
    await deliver(api, o.id);
    const d = dayIn('Asia/Dhaka');
    const dashboardProfit = (await dash(api)).profit;
    const a = await analytics(api, d);
    const s = await summary(api, d);

    // 2 x 850 - 100 + 60 = 1660 revenue; cost of goods 800; gross profit 860
    expect(dashboardProfit).toMatchObject({
      revenueMinor: 166_000,
      costMinor: 80_000,
      grossProfitMinor: 86_000,
    });
    expect(a.daily[0]).toMatchObject({ revenueMinor: 166_000, grossProfitMinor: 86_000 });
    expect(a.totalRevenueMinor).toBe(166_000);
    expect(a.totalCostMinor).toBe(80_000);
    expect(a.channels).toEqual([{ source: 'other', orders: 1, revenueMinor: 166_000 }]);
    expect(figure(s, 'revenue_goods') + figure(s, 'revenue_delivery')).toBe(166_000);
    expect(figure(s, 'cogs')).toBe(80_000);
    expect(s.estimatedProfitMinor).toBe(86_000); // no courier charges or costs recorded: net profit = gross profit
    // product lines are before order-level discount and delivery, which belong to no product
    expect(a.topProducts[0]).toMatchObject({ revenueMinor: 170_000, grossProfitMinor: 90_000 });
    expect(a.itemRevenueMinor).toBe(170_000);
  });

  it('a courier charge cannot be entered by hand, because statements already carry it', async () => {
    const { api } = await shop();
    for (const kind of ['delivery_charge', 'return_charge', 'courier_deduction'])
      expect((await cost(api, kind)).status).toBe(400);
    await cost(api, 'packaging').then((r) => expect(r.status).toBe(201));
  });

  it('an old hand-entered courier charge counts only while no statement covers the period, and can be voided', async () => {
    const { owner, api } = await shop();
    const v = await item(owner, 10, { price: 85_000, cost: 40_000 });
    await deliver(api, (await order(api, [{ variantId: v.id, quantity: 1 }])).id);
    const d = dayIn('Asia/Dhaka');
    const legacy = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.manualCost.create({
        data: {
          tenantId: owner.tenant.id,
          kind: 'delivery_charge',
          amountMinor: 6_000,
          incurredOn: new Date(`${d}T00:00:00Z`),
          note: 'old entry',
          idempotencyKey: key(),
          requestHash: 'legacy',
        },
      }),
    );
    expect((await api.get(`/v1/finance/costs?from=${d}&to=${d}`).expect(200)).body).toHaveLength(1);
    let s = await summary(api, d);
    expect(figure(s, 'manual_costs')).toBe(6_000);
    expect(s.estimatedProfitMinor).toBe(85_000 - 40_000 - 6_000);

    // a statement now reports courier charges for the period (a 25 fee): the old entry stops counting, so no charge counts twice
    const head =
      'transaction_id,consignment_id,tracking_code,reference,phone,date,type,collected,delivery_charge,cod_fee,return_charge,other_deduction,net,note';
    await api
      .post('/v1/settlements/import', {
        provider: 'steadfast',
        csv: `${head}\n,,,,,${d},adjustment,0,0,0,0,25,,Monthly fee`,
        fileName: 'statement.csv',
      })
      .expect(200);
    s = await summary(api, d);
    expect(figure(s, 'manual_costs')).toBe(0);
    expect(figure(s, 'courier_other')).toBe(2_500);
    expect(s.estimatedProfitMinor).toBe(85_000 - 40_000 - 2_500);
    expect(s.manualCostsByKind).toEqual([{ kind: 'delivery_charge', amountMinor: 6_000 }]);
    expect(s.caveats.join(' ')).toMatch(/recorded by hand before statements/);

    // the old row still shows and can be voided
    const voided = await api
      .post(`/v1/finance/costs/${legacy.id}/void`, { reason: 'Counted by the statement' })
      .expect(200);
    expect(voided.body.voidedAt).not.toBeNull();
  });
});
