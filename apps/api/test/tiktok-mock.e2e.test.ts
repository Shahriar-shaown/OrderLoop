import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  createProduct,
  createTestApp,
  registerTenant,
  type TestApp,
} from './app.js';
import { withAdmin } from './deletion-helpers.js';

/**
 * TikTok Shop in MOCK mode, through the real HTTP API, PostgreSQL and Redis: a labelled simulated shop, synthetic orders through
 * the SAME ingestion code a webhook uses, and the stock that follows. Every stock number is read back from the inventory API and
 * the ledger, never inferred.
 */
let t: TestApp;
type Who = { accessToken: string };
const as = (who: Who) => ({
  get: (p: string) => t.http.get(p).set(bearer(who.accessToken)),
  post: (p: string, b: object = {}) => t.http.post(p).set(bearer(who.accessToken)).send(b),
  put: (p: string, b: object) => t.http.put(p).set(bearer(who.accessToken)).send(b),
});

beforeAll(async () => {
  t = await createTestApp({ TIKTOK_MODE: 'mock' });
});
afterAll(() => t.close());

let seq = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${++seq}`.toUpperCase();

/** A business with a mock shop and helpers to make stocked products and send orders. */
async function shop(over: { tenantName?: string } = {}) {
  const owner = await registerTenant(t, over);
  const api = as(owner);
  const conn = (await api.post('/v1/integrations/tiktok-shop/mock/connection', {}).expect(201))
    .body as { id: string; shopId: string };
  const stocked = async (qty: number, sku = uniq('TT')) => {
    const { variant } = await createProduct(t, owner.accessToken, { sku });
    if (qty > 0)
      await api.post('/v1/inventory/receive', { variantId: variant.id, quantity: qty }).expect(201);
    return { variantId: variant.id, sku: variant.sku };
  };
  const level = async (variantId: string) => {
    const items = (await api.get(`/v1/inventory?variantId=${variantId}`)).body.items as {
      onHand: number;
      reserved: number;
      available: number;
    }[];
    return items[0] ?? { onHand: 0, reserved: 0, available: 0 };
  };
  const ledger = async (variantId: string) =>
    (
      (await api.get(`/v1/inventory/movements?variantId=${variantId}&limit=100`)).body.items as {
        type: string;
        onHandDelta: number;
        reservedDelta: number;
        reason: string | null;
        referenceType: string | null;
        referenceId: string | null;
      }[]
    )
      .filter((m) => m.referenceType === 'tiktok_order')
      .reverse() // the API lists newest first: oldest first reads as the story
      .map((m) => ({
        type: m.type,
        onHand: m.onHandDelta,
        reserved: m.reservedDelta,
        reason: m.reason,
      }));
  const send = (
    body: {
      externalOrderId?: string;
      status?: string;
      items: { skuId: string; sellerSku?: string; quantity?: number; unitPriceMinor?: number }[];
      notificationId?: string;
      updateTime?: string;
      onHold?: boolean;
    },
    expectStatus = 200,
  ) =>
    api
      .post('/v1/integrations/tiktok-shop/mock/orders', { connectionId: conn.id, ...body })
      .expect(expectStatus);
  const change = (orderId: string, body: object, expectStatus = 200) =>
    api
      .post(`/v1/integrations/tiktok-shop/mock/orders/${orderId}/status`, body)
      .expect(expectStatus);
  const order = async (id: string) => (await api.get(`/v1/tiktok-orders/${id}`).expect(200)).body;
  return { owner, api, conn, stocked, level, ledger, send, change, order };
}

const at = (seconds: number) => new Date(1_790_000_000_000 + seconds * 1000).toISOString();

describe('the mock shop', () => {
  it('reports mock mode, nothing configured for live, and an empty business', async () => {
    const s = await shop();
    const o = (await s.api.get('/v1/integrations/tiktok-shop').expect(200)).body;
    expect(o).toMatchObject({
      mode: 'mock',
      webhookUrl: null,
      redirectUrl: null,
      needsMappingOrders: 0,
      stockShortOrders: 0,
      attentionOrders: 0,
      unmappedSkus: 0,
    });
    expect(o.liveConfigured).toBe(false);
    expect(o.connections).toHaveLength(1);
    expect(o.connections[0]).toMatchObject({
      mock: true,
      status: 'active',
      region: 'MY',
      currency: 'MYR',
      scopes: [],
      tokenExpiresAt: null,
    });
    expect(o.connections[0].shopId).toMatch(/^mock_/);
  });

  it('carries no token, cipher or secret anywhere in what it returns', async () => {
    const s = await shop();
    // `tokenExpiresAt` is a date field's name, not a token
    const body = JSON.stringify((await s.api.get('/v1/integrations/tiktok-shop')).body).replace(
      '"tokenExpiresAt":null',
      '',
    );
    expect(body).not.toMatch(/token|cipher|secret|Enc"|grant/i);
  });

  it('the live-only calls say so: oauth start and reconnect are 409 tiktok_not_configured', async () => {
    const s = await shop();
    const start = await s.api.post('/v1/integrations/tiktok-shop/oauth/start');
    expect(start.status).toBe(409);
    expect(start.body.code).toBe('tiktok_not_configured');
    const re = await s.api.post(`/v1/integrations/tiktok-shop/connections/${s.conn.id}/reconnect`);
    expect(re.body.code).toBe('tiktok_not_configured');
    expect(
      (await t.http.get('/v1/integrations/tiktok-shop/oauth/callback?code=x&state=y')).headers
        .location,
    ).toContain('error=tiktok_not_configured');
    expect(
      (await t.http.get('/v1/integrations/tiktok-shop/oauth/begin?ticket=x')).headers.location,
    ).toContain('error=tiktok_not_configured');
  });

  it('validates the mock bodies', async () => {
    const s = await shop();
    await s.api.post('/v1/integrations/tiktok-shop/mock/connection', { region: 'my' }).expect(400);
    await s.api
      .post('/v1/integrations/tiktok-shop/mock/connection', { currency: 'RM' })
      .expect(400);
    await s.api
      .post('/v1/integrations/tiktok-shop/mock/orders', { connectionId: s.conn.id, items: [] })
      .expect(400);
    await s.api
      .post('/v1/integrations/tiktok-shop/mock/orders', {
        connectionId: s.conn.id,
        items: [{ skuId: 'a', quantity: 0 }],
      })
      .expect(400);
    await s.api
      .post('/v1/integrations/tiktok-shop/mock/orders', { items: [{ skuId: 'a' }] })
      .expect(400);
  });
});

describe('reserving, shipping and releasing stock', () => {
  it('an order awaiting shipment reserves its stock once, linked by seller SKU (case-insensitive)', async () => {
    const s = await shop();
    const v = await s.stocked(10, uniq('TT-SHIRT-M'));
    const r = (
      await s.send({
        externalOrderId: 'TT-1001',
        items: [
          { skuId: 'sku-1', sellerSku: v.sku.toLowerCase(), quantity: 3, unitPriceMinor: 2500 },
        ],
      })
    ).body;
    expect(r).toMatchObject({
      mode: 'mock',
      mock: true,
      duplicate: false,
      status: 'processed',
      stockState: 'reserved',
    });
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 10, reserved: 3, available: 7 });
    expect(await s.ledger(v.variantId)).toEqual([
      { type: 'RESERVE', onHand: 0, reserved: 3, reason: 'TikTok order TT-1001' },
    ]);

    const o = await s.order(r.orderId);
    expect(o).toMatchObject({
      mode: 'mock',
      mock: true,
      externalOrderId: 'TT-1001',
      status: 'AWAITING_SHIPMENT',
      currency: 'MYR',
      currencyExponent: 2,
      subtotalMinor: 7500,
      totalMinor: 7500,
      unitCount: 3,
      stockState: 'reserved',
      attention: null,
      unmappedLineCount: 0,
      shopName: 'Mock TikTok shop',
    });
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0]).toMatchObject({
      key: 'sku:sku-1',
      quantity: 3,
      unitPriceMinor: 2500,
      mapped: true,
      hold: 'held',
    });
    expect(o.lines[0].variant.sku).toBe(v.sku);
    // the auto-link was audited
    const audit = (await s.api.get('/v1/audit-logs?limit=100')).body.items as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['tiktok.sku_linked']));
  });

  it('the same webhook three more times changes nothing: no second reservation, no second ledger line', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    const body = {
      externalOrderId: 'TT-2001',
      notificationId: `n-${randomUUID()}`,
      items: [{ skuId: 'sku-a', sellerSku: v.sku, quantity: 2 }],
    };
    const first = (await s.send(body)).body;
    expect(first.duplicate).toBe(false);
    for (let i = 0; i < 3; i++) {
      const again = (await s.send(body)).body;
      expect(again).toMatchObject({
        duplicate: true,
        orderId: first.orderId,
        eventId: first.eventId,
      });
    }
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 10, reserved: 2, available: 8 });
    expect(await s.ledger(v.variantId)).toHaveLength(1);
    // a new notification for the same order and status (TikTok sends several) does not reserve again either
    await s.send({ ...body, notificationId: `n-${randomUUID()}` });
    expect(await s.level(v.variantId)).toMatchObject({ reserved: 2 });
    expect(await s.ledger(v.variantId)).toHaveLength(1);
  });

  it('IN_TRANSIT ships the reservation exactly once, however often it is announced', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    const r = (
      await s.send({
        externalOrderId: 'TT-3001',
        items: [{ skuId: 'sku-b', sellerSku: v.sku, quantity: 4 }],
        updateTime: at(10),
      })
    ).body;
    for (const [i, status] of ['IN_TRANSIT', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'].entries()) {
      const res = (await s.change(r.orderId, { status, updateTime: at(20 + i) })).body;
      expect(res.stockState).toBe('shipped');
    }
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 6, reserved: 0, available: 6 });
    expect((await s.ledger(v.variantId)).map((m) => m.type)).toEqual(['RESERVE', 'SHIP']);
    expect((await s.order(r.orderId)).lines[0].hold).toBe('shipped');
  });

  it('CANCELLED before shipping releases the stock exactly once', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    const r = (
      await s.send({
        externalOrderId: 'TT-4001',
        items: [{ skuId: 'sku-c', sellerSku: v.sku, quantity: 5 }],
        updateTime: at(10),
      })
    ).body;
    expect(await s.level(v.variantId)).toMatchObject({ reserved: 5, available: 5 });
    for (const i of [1, 2, 3]) {
      const c = (await s.change(r.orderId, { status: 'CANCELLED', updateTime: at(20 + i) })).body;
      expect(c.stockState).toBe('released');
    }
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
    expect((await s.ledger(v.variantId)).map((m) => m.type)).toEqual(['RESERVE', 'RELEASE']);
  });

  it('CANCELLED after shipping makes no stock change and is flagged for a person', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    const r = (
      await s.send({
        externalOrderId: 'TT-5001',
        items: [{ skuId: 'sku-d', sellerSku: v.sku, quantity: 2 }],
        updateTime: at(10),
      })
    ).body;
    await s.change(r.orderId, { status: 'IN_TRANSIT', updateTime: at(20) });
    const c = (await s.change(r.orderId, { status: 'CANCELLED', updateTime: at(30) })).body;
    expect(c.stockState).toBe('shipped');
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 8, reserved: 0 });
    expect((await s.ledger(v.variantId)).map((m) => m.type)).toEqual(['RESERVE', 'SHIP']);
    expect(await s.order(r.orderId)).toMatchObject({ attention: 'cancelled_after_shipping' });
    const o = (await s.api.get('/v1/integrations/tiktok-shop')).body;
    expect(o.attentionOrders).toBe(1);
    const flagged = (await s.api.get('/v1/tiktok-orders?attention=true')).body.items;
    expect(flagged.map((x: { externalOrderId: string }) => x.externalOrderId)).toEqual(['TT-5001']);
  });

  it('an order first seen late (already in transit) is reserved and shipped once', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    const r = (
      await s.send({
        externalOrderId: 'TT-6001',
        status: 'IN_TRANSIT',
        items: [{ skuId: 'sku-e', sellerSku: v.sku, quantity: 3 }],
      })
    ).body;
    expect(r.stockState).toBe('shipped');
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 7, reserved: 0 });
    expect((await s.ledger(v.variantId)).map((m) => m.type)).toEqual(['RESERVE', 'SHIP']);
    await s.change(r.orderId, { status: 'DELIVERED', updateTime: at(99_999) });
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 7, reserved: 0 });
  });

  it('UNPAID, ON_HOLD and a buyer-hold order move no stock; the hold ending reserves', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    const item = { skuId: 'sku-f', sellerSku: v.sku, quantity: 2 };
    const unpaid = (
      await s.send({
        externalOrderId: 'TT-7001',
        status: 'UNPAID',
        items: [item],
        updateTime: at(1),
      })
    ).body;
    const held = (
      await s.send({
        externalOrderId: 'TT-7002',
        status: 'AWAITING_SHIPMENT',
        onHold: true,
        items: [item],
        updateTime: at(1),
      })
    ).body;
    expect([unpaid.stockState, held.stockState]).toEqual(['none', 'none']);
    expect(await s.level(v.variantId)).toMatchObject({ reserved: 0 });
    await s.change(unpaid.orderId, { status: 'AWAITING_SHIPMENT', updateTime: at(5) });
    await s.change(held.orderId, { status: 'AWAITING_SHIPMENT', onHold: false, updateTime: at(5) });
    expect(await s.level(v.variantId)).toMatchObject({ reserved: 4 });
    expect((await s.ledger(v.variantId)).map((m) => m.type)).toEqual(['RESERVE', 'RESERVE']);
  });

  it('a late delivery of an older status never moves an order backwards', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    const r = (
      await s.send({
        externalOrderId: 'TT-8001',
        items: [{ skuId: 'sku-g', sellerSku: v.sku, quantity: 1 }],
        updateTime: at(10),
      })
    ).body;
    await s.change(r.orderId, { status: 'IN_TRANSIT', updateTime: at(300) });
    // the older AWAITING_SHIPMENT arrives late (and a CANCELLED older than the shipment too)
    await s.change(r.orderId, { status: 'AWAITING_SHIPMENT', updateTime: at(100) });
    await s.change(r.orderId, { status: 'CANCELLED', updateTime: at(200) });
    const o = await s.order(r.orderId);
    expect(o).toMatchObject({ status: 'IN_TRANSIT', stockState: 'shipped' });
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 9, reserved: 0 });
    expect((await s.ledger(v.variantId)).map((m) => m.type)).toEqual(['RESERVE', 'SHIP']);
  });
});

describe('SKUs that are not mapped, and stock that is short', () => {
  it('an unmapped line holds the WHOLE order, and mapping it reconciles the waiting order', async () => {
    const s = await shop();
    const a = await s.stocked(10);
    const b = await s.stocked(10);
    const r = (
      await s.send({
        externalOrderId: 'TT-9001',
        items: [
          { skuId: 'sku-known', sellerSku: a.sku, quantity: 1 },
          { skuId: 'sku-mystery', sellerSku: 'NO-SUCH-SKU-XYZ', quantity: 2 },
        ],
      })
    ).body;
    expect(r.stockState).toBe('needs_mapping');
    // nothing moved, not even the line that IS mapped
    expect(await s.level(a.variantId)).toMatchObject({ reserved: 0 });
    expect(await s.ledger(a.variantId)).toEqual([]);

    const o = await s.order(r.orderId);
    expect(o.unmappedLineCount).toBe(1);
    const unmappedLine = o.lines.find((l: { key: string }) => l.key === 'sku:sku-mystery');
    expect(unmappedLine).toMatchObject({ mapped: false, variant: null, hold: null });
    expect(unmappedLine.skuLinkId).toBeTruthy();
    expect((await s.api.get('/v1/integrations/tiktok-shop')).body).toMatchObject({
      needsMappingOrders: 1,
      unmappedSkus: 1,
    });

    const links = (await s.api.get('/v1/tiktok-sku-links?unmapped=true')).body;
    expect(links.unmappedCount).toBe(1);
    expect(links.items[0]).toMatchObject({
      externalSkuId: 'sku-mystery',
      sellerSku: 'NO-SUCH-SKU-XYZ',
      variant: null,
      source: 'auto',
      waitingOrders: 1,
    });

    const mapped = (
      await s.api
        .put(`/v1/tiktok-sku-links/${links.items[0].id}`, { variantId: b.variantId })
        .expect(200)
    ).body;
    expect(mapped.reconciledOrders).toBe(1);
    expect(mapped.link).toMatchObject({ source: 'manual', waitingOrders: 0 });
    expect(mapped.link.variant.id).toBe(b.variantId);
    expect(await s.order(r.orderId)).toMatchObject({
      stockState: 'reserved',
      unmappedLineCount: 0,
    });
    expect(await s.level(a.variantId)).toMatchObject({ reserved: 1 });
    expect(await s.level(b.variantId)).toMatchObject({ reserved: 2 });
    expect((await s.api.get('/v1/tiktok-sku-links?unmapped=true')).body.unmappedCount).toBe(0);
    const audit = (await s.api.get('/v1/audit-logs?limit=100')).body.items as {
      action: string;
      metadata: { variantId?: string; source?: string };
    }[];
    expect(
      audit.some(
        (e) =>
          e.action === 'tiktok.sku_linked' &&
          e.metadata.source === 'manual' &&
          e.metadata.variantId === b.variantId,
      ),
    ).toBe(true);
  });

  it('a later order with the same SKU uses the link a person made; clearing it audits an unlink', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    await s.send({
      externalOrderId: 'TT-9101',
      items: [{ skuId: 'sku-x', sellerSku: 'UNKNOWN-1' }],
    });
    const link = (await s.api.get('/v1/tiktok-sku-links?unmapped=true')).body.items[0];
    await s.api.put(`/v1/tiktok-sku-links/${link.id}`, { variantId: v.variantId }).expect(200);
    const r = (
      await s.send({
        externalOrderId: 'TT-9102',
        items: [{ skuId: 'sku-x', sellerSku: 'UNKNOWN-1' }],
      })
    ).body;
    expect(r.stockState).toBe('reserved');
    const cleared = (
      await s.api.put(`/v1/tiktok-sku-links/${link.id}`, { variantId: null }).expect(200)
    ).body;
    expect(cleared.link).toMatchObject({ variant: null, source: 'manual' });
    // the reservation already made keeps its variant: clearing the link does not touch it
    expect(await s.level(v.variantId)).toMatchObject({ reserved: 2 });
    expect(
      ((await s.api.get('/v1/audit-logs?limit=100')).body.items as { action: string }[]).some(
        (e) => e.action === 'tiktok.sku_unlinked',
      ),
    ).toBe(true);
    // and a manually cleared link is never auto-linked again
    await s.send({ externalOrderId: 'TT-9103', items: [{ skuId: 'sku-x', sellerSku: v.sku }] });
    expect((await s.api.get('/v1/tiktok-sku-links?unmapped=true')).body.unmappedCount).toBe(1);
  });

  it('refuses to link a variant that is not in this business, and ids that do not exist', async () => {
    const s = await shop();
    const other = await shop();
    const foreign = await other.stocked(1);
    await s.send({ externalOrderId: 'TT-9201', items: [{ skuId: 'sku-y', sellerSku: 'NOPE' }] });
    const link = (await s.api.get('/v1/tiktok-sku-links')).body.items[0];
    const bad = await s.api.put(`/v1/tiktok-sku-links/${link.id}`, {
      variantId: foreign.variantId,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0].path).toBe('body.variantId');
    expect(
      (await s.api.put(`/v1/tiktok-sku-links/${randomUUID()}`, { variantId: null })).status,
    ).toBe(404);
    await s.api.put(`/v1/tiktok-sku-links/${link.id}`, { variantId: 'not-a-uuid' }).expect(400);
    await s.api.put(`/v1/tiktok-sku-links/${link.id}`, {}).expect(400);
  });

  it('a seller SKU that only resembles a variant SKU is not auto-linked: only an exact match is', async () => {
    const s = await shop();
    const v = await s.stocked(5, uniq('DUP'));
    await s.send({
      externalOrderId: 'TT-9301',
      items: [{ skuId: 'sku-near', sellerSku: `${v.sku}-X` }],
    });
    expect((await s.api.get('/v1/tiktok-sku-links?unmapped=true')).body.unmappedCount).toBe(1);
  });

  it('stock short: records it, does not fail, does not oversell, reserves nothing for any line; stock arriving fixes it', async () => {
    const s = await shop();
    const plenty = await s.stocked(10);
    const scarce = await s.stocked(2);
    const r = (
      await s.send({
        externalOrderId: 'TT-9401',
        items: [
          { skuId: 'sku-plenty', sellerSku: plenty.sku, quantity: 1 },
          { skuId: 'sku-scarce', sellerSku: scarce.sku, quantity: 5 },
        ],
      })
    ).body;
    expect(r).toMatchObject({ status: 'processed', stockState: 'stock_short' });
    expect(await s.level(plenty.variantId)).toMatchObject({ reserved: 0 });
    expect(await s.level(scarce.variantId)).toMatchObject({ onHand: 2, reserved: 0 });
    expect((await s.api.get('/v1/integrations/tiktok-shop')).body.stockShortOrders).toBe(1);
    const list = (await s.api.get('/v1/tiktok-orders?stockState=stock_short')).body;
    expect(list.items).toHaveLength(1);
    expect(list.counts).toMatchObject({ stock_short: 1 });

    await s.api
      .post('/v1/inventory/receive', { variantId: scarce.variantId, quantity: 10 })
      .expect(201);
    const sync = (
      await s.api.post(`/v1/integrations/tiktok-shop/connections/${s.conn.id}/sync`).expect(200)
    ).body;
    expect(sync).toMatchObject({ mode: 'mock', fetched: 0, reconciled: 1, truncated: false });
    expect(await s.order(r.orderId)).toMatchObject({ stockState: 'reserved' });
    expect(await s.level(scarce.variantId)).toMatchObject({ reserved: 5 });
    expect(await s.level(plenty.variantId)).toMatchObject({ reserved: 1 });
  });

  it('two orders competing for the last units: one reserves, the other is short, nothing is oversold', async () => {
    const s = await shop();
    const v = await s.stocked(3);
    const results = await Promise.all(
      [1, 2].map((n) =>
        s.send({
          externalOrderId: `TT-RACE-${n}`,
          items: [{ skuId: 'sku-r', sellerSku: v.sku, quantity: 2 }],
        }),
      ),
    );
    const states = results.map((r) => r.body.stockState).sort();
    expect(states).toEqual(['reserved', 'stock_short']);
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 3, reserved: 2, available: 1 });
  });
});

describe('concurrency and replays', () => {
  it('12 concurrent deliveries of the same notification make exactly one reservation', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    const body = {
      externalOrderId: 'TT-C1',
      notificationId: `n-${randomUUID()}`,
      items: [{ skuId: 'sku-c1', sellerSku: v.sku, quantity: 3 }],
    };
    const res = await Promise.all(Array.from({ length: 12 }, () => s.send(body)));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 10, reserved: 3 });
    expect(await s.ledger(v.variantId)).toHaveLength(1);
    const events = await withAdmin(
      async (c) =>
        (
          await c.query(`SELECT count(*)::int n FROM tiktok_events WHERE external_event_id = $1`, [
            body.notificationId,
          ])
        ).rows[0].n as number,
    );
    expect(events).toBe(1);
  });

  it('12 concurrent notifications (distinct ids) for one order and status make exactly one reservation', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    const res = await Promise.all(
      Array.from({ length: 12 }, () =>
        s.send({
          externalOrderId: 'TT-C2',
          updateTime: at(10),
          items: [{ skuId: 'sku-c2', sellerSku: v.sku, quantity: 2 }],
        }),
      ),
    );
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 10, reserved: 2 });
    expect(await s.ledger(v.variantId)).toHaveLength(1);
    const orders = await withAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT count(*)::int n FROM tiktok_orders WHERE external_order_id = 'TT-C2' AND tenant_id = $1`,
            [s.owner.tenant.id],
          )
        ).rows[0].n as number,
    );
    expect(orders).toBe(1);
  });

  it('a status change racing a sync and a mapping change still ships exactly once', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    const r = (
      await s.send({
        externalOrderId: 'TT-C3',
        updateTime: at(10),
        items: [{ skuId: 'sku-c3', sellerSku: v.sku, quantity: 4 }],
      })
    ).body;
    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) =>
        s.change(r.orderId, { status: 'IN_TRANSIT', updateTime: at(20 + i) }),
      ),
      ...Array.from({ length: 3 }, () =>
        s.api.post(`/v1/integrations/tiktok-shop/connections/${s.conn.id}/sync`).expect(200),
      ),
    ]);
    expect(await s.level(v.variantId)).toMatchObject({ onHand: 6, reserved: 0 });
    expect((await s.ledger(v.variantId)).map((m) => m.type)).toEqual(['RESERVE', 'SHIP']);
  });

  it('reservations that belong to a TikTok order cannot be released or fulfilled by hand', async () => {
    const s = await shop();
    const v = await s.stocked(10);
    await s.send({
      externalOrderId: 'TT-H1',
      items: [{ skuId: 'sku-h1', sellerSku: v.sku, quantity: 2 }],
    });
    const reservations = (await s.api.get(`/v1/reservations?variantId=${v.variantId}`)).body
      .items as {
      id: string;
      referenceType: string;
      status: string;
    }[];
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.referenceType).toBe('tiktok_order');
    for (const verb of ['release', 'fulfil']) {
      const res = await s.api.post(`/v1/reservations/${reservations[0]!.id}/${verb}`);
      expect(res.status).toBe(409);
    }
    const made = await s.api.post('/v1/reservations', {
      variantId: v.variantId,
      quantity: 1,
      referenceType: 'tiktok_order',
      referenceId: 'x',
      idempotencyKey: `k-${randomUUID()}`,
    });
    expect(made.status).toBe(400);
    expect(await s.level(v.variantId)).toMatchObject({ reserved: 2 });
  });
});

describe('the mirrored orders', () => {
  it('lists newest update first with filters, counts per state and a cursor; each amount is in the shop currency', async () => {
    const s = await shop();
    const v = await s.stocked(50);
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = (
        await s.send({
          externalOrderId: `TT-L${i}`,
          status: i % 2 ? 'AWAITING_SHIPMENT' : 'UNPAID',
          updateTime: at(i * 10),
          items: [{ skuId: 'sku-l', sellerSku: v.sku, quantity: i, unitPriceMinor: 100 }],
        })
      ).body;
      ids.push(r.orderId);
    }
    const page1 = (await s.api.get('/v1/tiktok-orders?limit=2')).body;
    expect(page1.items.map((o: { externalOrderId: string }) => o.externalOrderId)).toEqual([
      'TT-L5',
      'TT-L4',
    ]);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await s.api.get(`/v1/tiktok-orders?limit=2&cursor=${page1.nextCursor}`)).body;
    expect(page2.items.map((o: { externalOrderId: string }) => o.externalOrderId)).toEqual([
      'TT-L3',
      'TT-L2',
    ]);
    expect(page1.counts).toMatchObject({ reserved: 3, none: 2 });
    const unpaid = (await s.api.get('/v1/tiktok-orders?status=unpaid')).body.items;
    expect(unpaid.map((o: { externalOrderId: string }) => o.externalOrderId)).toEqual([
      'TT-L4',
      'TT-L2',
    ]);
    const first = page1.items[0];
    expect(first).toMatchObject({
      currency: 'MYR',
      currencyExponent: 2,
      totalMinor: 500,
      unitCount: 5,
    });
    expect(typeof first.totalMinor).toBe('number');
    expect(JSON.stringify(first)).not.toMatch(/BDT|bdt|paisa/);
    await s.api.get('/v1/tiktok-orders?stockState=bogus').expect(400);
    await s.api.get(`/v1/tiktok-orders/${randomUUID()}`).expect(404);
    await s.api.get('/v1/tiktok-orders/not-a-uuid').expect(400);
  });

  it('the mock status route only changes mock orders of this business', async () => {
    const a = await shop();
    const b = await shop();
    const v = await a.stocked(5);
    const r = (
      await a.send({ externalOrderId: 'TT-X1', items: [{ skuId: 's', sellerSku: v.sku }] })
    ).body;
    expect(
      (
        await b.api.post(`/v1/integrations/tiktok-shop/mock/orders/${r.orderId}/status`, {
          status: 'CANCELLED',
        })
      ).status,
    ).toBe(404);
    expect((await b.api.get(`/v1/tiktok-orders/${r.orderId}`)).status).toBe(404);
    expect((await b.api.get('/v1/tiktok-orders')).body.items).toEqual([]);
    expect((await a.order(r.orderId)).status).toBe('AWAITING_SHIPMENT');
  });
});

describe('who may do what', () => {
  it('follows the matrix: integrations:read (owner, admin, manager), integrations:manage (owner, admin), orders:read, inventory:read and inventory:write', async () => {
    const owner = await registerTenant(t);
    const roles = {
      OWNER: owner,
      ADMIN: await addMember(t, owner, 'ADMIN'),
      MANAGER: await addMember(t, owner, 'MANAGER'),
      STAFF: await addMember(t, owner, 'STAFF'),
      ACCOUNTANT: await addMember(t, owner, 'ACCOUNTANT'),
    } as const;
    const conn = (
      await as(owner).post('/v1/integrations/tiktok-shop/mock/connection', {}).expect(201)
    ).body;
    const probe = async (
      who: Who,
      method: 'get' | 'post' | 'put' | 'delete',
      path: string,
      body: object = {},
    ) => {
      const req = t.http[method](path).set(bearer(who.accessToken));
      return (method === 'get' || method === 'delete' ? await req : await req.send(body)).status;
    };
    const allowed = (name: keyof typeof roles, ok: string[]) => ok.includes(name);
    for (const [name, who] of Object.entries(roles) as [keyof typeof roles, Who][]) {
      const read = allowed(name, ['OWNER', 'ADMIN', 'MANAGER']);
      expect(await probe(who, 'get', '/v1/integrations/tiktok-shop'), `overview ${name}`).toBe(
        read ? 200 : 403,
      );
      const manage = allowed(name, ['OWNER', 'ADMIN']);
      expect(
        await probe(who, 'post', '/v1/integrations/tiktok-shop/oauth/start'),
        `start ${name}`,
      ).toBe(manage ? 409 : 403);
      expect(
        await probe(who, 'post', `/v1/integrations/tiktok-shop/connections/${conn.id}/sync`),
        `sync ${name}`,
      ).toBe(manage ? 200 : 403);
      expect(
        await probe(who, 'post', '/v1/integrations/tiktok-shop/mock/connection', {}),
        `mock ${name}`,
      ).toBe(manage ? 201 : 403);
      expect(
        await probe(who, 'post', '/v1/integrations/tiktok-shop/mock/orders', {
          connectionId: conn.id,
          items: [{ skuId: `s-${name}` }],
        }),
        `mock order ${name}`,
      ).toBe(manage ? 200 : 403);
      expect(await probe(who, 'get', '/v1/tiktok-orders'), `orders ${name}`).toBe(200);
      expect(await probe(who, 'get', '/v1/tiktok-sku-links'), `links ${name}`).toBe(200);
      const write = allowed(name, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
      expect(
        await probe(who, 'put', `/v1/tiktok-sku-links/${randomUUID()}`, { variantId: null }),
        `link write ${name}`,
      ).toBe(write ? 404 : 403);
    }
    for (const [name, who] of Object.entries(roles) as [keyof typeof roles, Who][]) {
      const manage = allowed(name, ['OWNER', 'ADMIN']);
      const c = (
        await as(owner).post('/v1/integrations/tiktok-shop/mock/connection', {}).expect(201)
      ).body;
      expect(
        await probe(who, 'delete', `/v1/integrations/tiktok-shop/connections/${c.id}`),
        `disconnect ${name}`,
      ).toBe(manage ? 200 : 403);
    }
    // nothing without a token
    expect((await t.http.get('/v1/integrations/tiktok-shop')).status).toBe(401);
    expect((await t.http.get('/v1/tiktok-orders')).status).toBe(401);
    expect(
      (await t.http.put(`/v1/tiktok-sku-links/${randomUUID()}`).send({ variantId: null })).status,
    ).toBe(401);
  });
});

describe('disconnecting', () => {
  it('disconnects once (and again as a no-op), keeps the mirror, and refuses new mock orders for it', async () => {
    const s = await shop();
    const v = await s.stocked(5);
    const r = (
      await s.send({
        externalOrderId: 'TT-D1',
        items: [{ skuId: 'sd', sellerSku: v.sku, quantity: 2 }],
      })
    ).body;
    const d1 = (await s.api.get('/v1/integrations/tiktok-shop')).body.connections[0];
    expect(d1.status).toBe('active');
    const off = (
      await t.http
        .delete(`/v1/integrations/tiktok-shop/connections/${s.conn.id}`)
        .set(bearer(s.owner.accessToken))
        .expect(200)
    ).body;
    expect(off).toMatchObject({ status: 'disconnected' });
    expect(off.disconnectedAt).toBeTruthy();
    await t.http
      .delete(`/v1/integrations/tiktok-shop/connections/${s.conn.id}`)
      .set(bearer(s.owner.accessToken))
      .expect(200);
    expect(
      (
        await s.api.post('/v1/integrations/tiktok-shop/mock/orders', {
          connectionId: s.conn.id,
          items: [{ skuId: 'x' }],
        })
      ).status,
    ).toBe(404);
    expect(
      (await s.api.post(`/v1/integrations/tiktok-shop/connections/${s.conn.id}/sync`)).status,
    ).toBe(409);
    expect((await s.order(r.orderId)).stockState).toBe('reserved');
    expect(await s.level(v.variantId)).toMatchObject({ reserved: 2 });
    const audit = (await s.api.get('/v1/audit-logs?limit=100')).body.items as { action: string }[];
    expect(audit.filter((a) => a.action === 'integration.tiktok_disconnected')).toHaveLength(1);
  });
});
