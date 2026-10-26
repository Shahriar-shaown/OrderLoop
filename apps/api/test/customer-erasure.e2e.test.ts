import { randomUUID } from 'node:crypto';
import { fakeNetwork } from '@orderloop/courier-sdk';
import { processSocialEvent } from '@orderloop/automation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  createProduct,
  createTestApp,
  registerTenant,
  type TestApp,
} from './app.js';
import { drain, fakeQueue, type FakeQueue } from './automation-helpers.js';
import { findLeaks, tenantText, withAdmin } from './deletion-helpers.js';

/**
 * Erasing one customer's personal data (docs/privacy-and-deletion.md): what goes, what stays, who may, and that no copy of the
 * old name or number is left anywhere in the business. These are technical behaviours, not a legal statement.
 */
let t: TestApp;
let net = fakeNetwork({});
let consignment = 7000;
let metaQueue: FakeQueue;
beforeAll(async () => {
  metaQueue = fakeQueue();
  t = await createTestApp(
    { META_MODE: 'mock' },
    {
      courier: {
        fetch: (url: string, init: unknown) =>
          (net.fetch as never as (u: string, i: unknown) => unknown)(url, init),
        sleep: async () => undefined,
      },
      meta: { events: metaQueue },
    },
  );
});
afterAll(() => t.close());

type Who = { accessToken: string };
let seq = 0;
const key = (p = 'er') => `${p}-${Date.now()}-${++seq}`;
const call = (who: Who) => ({
  get: (path: string) => t.http.get(path).set(bearer(who.accessToken)),
  post: (path: string, body: object = {}) =>
    t.http.post(path).set(bearer(who.accessToken)).send(body),
  patch: (path: string, body: object) => t.http.patch(path).set(bearer(who.accessToken)).send(body),
});
type Api = ReturnType<typeof call>;

const TOKEN = 'steadfast-token-0123456789';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

// Fictional people. Nothing here is a real name or number.
const RAHIM = {
  name: 'Rahim Uddin',
  phone: '01712345678',
  line1: 'House 12, Road 5, Dhanmondi',
};
const KARIM = { name: 'Karim Hossain', phone: '01898765432', line1: 'Flat 4B, Gulshan Avenue' };

/** A business connected to Steadfast (a fake network: nothing real is contacted) with stock to sell. */
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
  const { variant } = await createProduct(t, owner.accessToken, { priceMinor: 100_000 });
  await api.post('/v1/inventory/receive', { variantId: variant.id, quantity: 100 }).expect(201);
  return { owner, api, hookPath, tenantId: owner.tenant.id, variantId: variant.id };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const addr = (p: typeof RAHIM) => ({
  recipientName: p.name,
  phone: p.phone,
  line1: p.line1,
  area: 'Dhanmondi',
  district: 'Dhaka',
  division: 'Dhaka',
  postalCode: '1209',
});

/** An order for a person, taken as far as `upTo`: pending, confirmed, ready (stops there), booked, delivered. */
async function order(
  s: Shop,
  who: typeof RAHIM,
  upTo: 'pending' | 'confirmed' | 'delivered' | 'cancelled',
  opts: { notes?: string; cancelReason?: string } = {},
) {
  const created = await s.api
    .post('/v1/orders', {
      customer: { name: who.name, phone: who.phone },
      address: addr(who),
      items: [{ variantId: s.variantId, quantity: 1 }],
      deliveryChargeMinor: 6_000,
      idempotencyKey: key('ord'),
      notes: opts.notes,
      confirm: upTo !== 'pending',
    })
    .expect(201);
  const id = created.body.id as string;
  const number = created.body.orderNumber as number;
  const customerId = created.body.customer.id;
  let consignmentId: string | undefined;
  if (upTo === 'delivered') {
    await s.api.post(`/v1/orders/${id}/status`, { status: 'ready_to_ship' }).expect(200);
    const booked = await s.api
      .post(`/v1/orders/${id}/shipments`, { provider: 'steadfast', idempotencyKey: key('bk') })
      .expect(201);
    consignmentId = booked.body.consignmentId as string;
    await t.http
      .post(s.hookPath)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        notification_type: 'delivery_status',
        consignment_id: Number(consignmentId),
        invoice: `OL-${number}`,
        cod_amount: 1060,
        status: 'delivered',
        delivery_charge: 60,
        tracking_message: `Delivered to ${who.name}`,
        updated_at: '2026-10-18 10:00:00',
      })
      .expect(200);
  }
  if (upTo === 'cancelled')
    await s.api
      .post(`/v1/orders/${id}/status`, {
        status: 'cancelled',
        reason: opts.cancelReason ?? 'Changed their mind',
      })
      .expect(200);
  return { id, number, customerId: customerId as string, consignmentId };
}

const customerIdOf = async (s: Shop, phone: string) =>
  (await s.api.get(`/v1/customers?q=${phone}`).expect(200)).body.items[0].id as string;

const erase = (api: Api, id: string, body: object = { confirm: true }) =>
  api.post(`/v1/customers/${id}/erase`, body);

describe('who may erase, and what is refused', () => {
  it('needs customers:erase (owner and admin), a confirmation, and a customer of this business', async () => {
    const s = await shop();
    await order(s, RAHIM, 'cancelled');
    const id = await customerIdOf(s, RAHIM.phone);

    const admin = await addMember(t, s.owner, 'ADMIN');
    const refused = [
      await addMember(t, s.owner, 'MANAGER'),
      await addMember(t, s.owner, 'STAFF'),
      await addMember(t, s.owner, 'ACCOUNTANT'),
    ];
    for (const who of refused) expect((await erase(call(who), id)).status).toBe(403);
    expect((await t.http.post(`/v1/customers/${id}/erase`).send({ confirm: true })).status).toBe(
      401,
    );

    // not confirmed: nothing happens
    expect((await erase(s.api, id, {})).status).toBe(400);
    expect((await erase(s.api, id, { confirm: false })).status).toBe(400);
    expect((await s.api.get(`/v1/customers/${id}`)).body.name).toBe(RAHIM.name);

    // another business's owner gets 404 (not 403: the id must not be probed) and nothing changes
    const other = await shop();
    expect((await erase(other.api, id)).status).toBe(404);
    expect((await s.api.get(`/v1/customers/${id}`)).body.name).toBe(RAHIM.name);
    expect((await erase(s.api, randomUUID())).status).toBe(404);

    await erase(call(admin), id).expect(200);
    expect((await s.api.get(`/v1/customers/${id}`)).body.erasedAt).not.toBeNull();
  });

  it('is refused with 409 erase_blocked while an order is in progress, and says how many', async () => {
    const s = await shop();
    await order(s, RAHIM, 'confirmed');
    await order(s, RAHIM, 'pending');
    await order(s, RAHIM, 'cancelled');
    const id = await customerIdOf(s, RAHIM.phone);
    const blocked = await erase(s.api, id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('erase_blocked');
    expect(blocked.body.detail).toContain('2 order(s) in progress');
    // nothing was touched
    const c = (await s.api.get(`/v1/customers/${id}`)).body;
    expect(c).toMatchObject({ name: RAHIM.name, erasedAt: null });
    expect(c.addresses.length).toBeGreaterThan(0);
    // finish them (cancel), and it goes through
    const orders = (await s.api.get(`/v1/customers/${id}/orders`)).body.items as {
      id: string;
      status: string;
    }[];
    for (const o of orders.filter((x) => x.status !== 'cancelled'))
      await s.api
        .post(`/v1/orders/${o.id}/status`, { status: 'cancelled', reason: 'Not needed' })
        .expect(200);
    await erase(s.api, id).expect(200);
  });
});

describe('what an erasure does', () => {
  it('leaves no copy of the name, number or address anywhere in the business, and keeps the money right', async () => {
    const s = await shop();
    // created through the API with a key, so a stored answer to a repeated request holds their details too
    await s.api
      .post('/v1/customers', { name: RAHIM.name, phone: RAHIM.phone, idempotencyKey: key('cu') })
      .expect(201);
    const delivered = await order(s, RAHIM, 'delivered', { notes: 'Rahim Uddin wants a gift box' });
    const cancelled = await order(s, RAHIM, 'cancelled', {
      cancelReason: 'Rahim Uddin changed his mind, called from 01712345678',
    });
    const control = await order(s, KARIM, 'delivered', { notes: 'Leave with the guard' });
    const id = await customerIdOf(s, RAHIM.phone);
    const controlId = await customerIdOf(s, KARIM.phone);
    await s.api
      .patch(`/v1/customers/${id}`, { email: 'rahim.uddin@example.test', notes: 'Prefers calls' })
      .expect(200);
    await s.api
      .post(`/v1/customers/${id}/addresses`, {
        recipientName: 'Rahim Uddin',
        phone: '01912345678',
        line1: 'Office: 3rd floor, Motijheel Commercial Area',
        area: 'Motijheel',
        district: 'Dhaka',
        division: 'Dhaka',
      })
      .expect(201);

    // what the courier sent about the delivery, with the recipient spelled out (a real courier's payload holds these)
    await withAdmin((c) =>
      c.query(
        `UPDATE shipment_events SET payload = $2::jsonb
         WHERE tenant_id = $1 AND shipment_id IN (SELECT id FROM shipments s WHERE s.tenant_id = $1 AND s.order_id = $3::uuid)`,
        [
          s.tenantId,
          JSON.stringify({
            status: 'delivered',
            consignment: {
              recipient_name: 'Rahim Uddin',
              recipient_phone: '01712345678',
              recipient_address: 'House 12, Road 5, Dhanmondi',
              cod_amount: 1060,
            },
          }),
          delivered.id,
        ],
      ),
    );
    // and what a courier's statement said about it (the phone is in its own column and in the raw line)
    const d = today();
    const csv = [
      'transaction_id,consignment_id,tracking_code,reference,phone,date,type,collected,delivery_charge,cod_fee,return_charge,other_deduction,net,note',
      `T1,${delivered.consignmentId},,OL-${delivered.number},01712345678,${d},cod,"1,060.00",60,10.60,0,0,989.40,Paid by Rahim Uddin`,
      `T2,${control.consignmentId},,OL-${control.number},01898765432,${d},cod,"1,060.00",60,10.60,0,0,989.40,Paid by Karim Hossain`,
    ].join('\n');
    const imported = await s.api
      .post('/v1/settlements/import', { provider: 'steadfast', csv, fileName: 'statement.csv' })
      .expect(200);
    // the figures finance reads (without the moment they were read at)
    const money = async () => {
      const strip = ({ asOf: _asOf, ...rest }: Record<string, unknown>) => rest;
      return {
        outstanding: strip((await s.api.get('/v1/finance/outstanding').expect(200)).body),
        summary: strip((await s.api.get('/v1/finance/summary').expect(200)).body),
      };
    };
    expect(imported.body.batchId ?? imported.body.id).toBeTruthy();

    // a conversation on Meta that quotes the number, and a note somewhere else that mentions the customer
    const a = call(s.owner);
    const conn = (
      await a
        .post('/v1/integrations/meta/mock/connection', { provider: 'facebook_page' })
        .expect(201)
    ).body as { id: string };
    await a
      .post('/v1/integrations/meta/mock/events', {
        connectionId: conn.id,
        senderId: 'PSID-RAHIM',
        text: `Name: Rahim Uddin\nPhone: 01712345678\nAddress: House 12, Road 5, Dhanmondi, Dhaka\n1 pcs ${randomUUID().slice(0, 4)}`,
      })
      .expect(200);
    await drain(metaQueue, (job) =>
      processSocialEvent(
        { db: t.db, log: () => undefined },
        job.data as { tenantId: string; eventId: string },
      ),
    );
    await a
      .post('/v1/finance/costs', {
        kind: 'packaging',
        amountMinor: 5_000,
        incurredOn: d,
        note: 'Box for Rahim Uddin 01712345678',
        idempotencyKey: key('cost'),
      })
      .then((r) => expect([201, 400]).toContain(r.status));

    // cash the business collected itself for another delivered order, with a note that names the customer
    const handed = await order(s, RAHIM, 'delivered');
    await a
      .post(`/v1/orders/${handed.id}/cod-receipts`, {
        amountMinor: 50_000,
        receivedOn: d,
        note: 'Cash from Rahim Uddin 01712345678',
        idempotencyKey: key('rc'),
      })
      .then((r) => expect([201, 409]).toContain(r.status));

    const moneyBefore = await money();
    const leaksBefore = await withAdmin(async (c) =>
      findLeaks(await tenantText(c, s.tenantId), ['Rahim Uddin', '1712345678', 'Dhanmondi, Dhaka']),
    );
    // the scan really does see the data before (so an empty result afterwards means something)
    expect(leaksBefore).toEqual(
      expect.arrayContaining([
        'customers.name',
        'orders.ship_name',
        'orders.ship_phone',
        'customer_addresses.phone',
        'settlement_items.phone',
        'settlement_items.raw',
        'shipment_events.payload',
        'order_status_history.reason',
        'cod_receipts.note',
        'idempotency_keys.response_body',
      ]),
    );
    const ordersBefore = (await s.api.get('/v1/orders?limit=100').expect(200)).body.items as {
      id: string;
      status: string;
      totalMinor: number;
      codAmountMinor: number;
      orderNumber: number;
    }[];

    const res = await erase(s.api, id, {
      confirm: true,
      reason: 'Customer Rahim Uddin asked by phone',
    }).expect(200);
    expect(res.body).toMatchObject({ customerId: id, ordersAnonymised: 3 });
    expect(typeof res.body.erasedAt).toBe('string');

    // 1. no copy of the old details anywhere in the business (every text and JSON column of every table)
    const cells = await withAdmin((c) => tenantText(c, s.tenantId));
    expect(
      findLeaks(cells, [
        'Rahim',
        'Uddin',
        '1712345678',
        '01912345678',
        'rahim.uddin@example.test',
        'Prefers calls',
        'House 12',
        'Motijheel',
        'gift box',
      ]),
    ).toEqual([]);
    // ... and the other customer is untouched
    expect(findLeaks(cells, ['Karim Hossain', '1898765432', 'Flat 4B'])).toEqual(
      expect.arrayContaining(['customers.name', 'orders.ship_name', 'orders.ship_line1']),
    );
    expect((await s.api.get(`/v1/customers/${controlId}`)).body).toMatchObject({
      name: KARIM.name,
      phone: expect.stringContaining('1898765432'),
      erasedAt: null,
    });

    // 2. the customer row stays, as a placeholder with no addresses
    const c = (await s.api.get(`/v1/customers/${id}`).expect(200)).body;
    expect(c).toMatchObject({ name: 'Erased customer', email: null, notes: null, addresses: [] });
    expect(c.phone).toMatch(/^erased-/);
    expect(c.erasedAt).toBe(res.body.erasedAt);

    // 3. orders keep their totals, statuses and numbers; only the copies of personal details changed
    const ordersAfter = (await s.api.get('/v1/orders?limit=100').expect(200)).body
      .items as typeof ordersBefore;
    expect(
      ordersAfter
        .map(({ id: i, status, totalMinor, codAmountMinor, orderNumber }) => ({
          i,
          status,
          totalMinor,
          codAmountMinor,
          orderNumber,
        }))
        .sort((x, y) => x.orderNumber - y.orderNumber),
    ).toEqual(
      ordersBefore
        .map(({ id: i, status, totalMinor, codAmountMinor, orderNumber }) => ({
          i,
          status,
          totalMinor,
          codAmountMinor,
          orderNumber,
        }))
        .sort((x, y) => x.orderNumber - y.orderNumber),
    );
    const detail = (await s.api.get(`/v1/orders/${delivered.id}`).expect(200)).body;
    expect(detail).toMatchObject({ status: 'delivered' });
    expect(JSON.stringify(detail)).not.toContain('Rahim');
    expect(await money()).toEqual(moneyBefore);
    expect(cancelled.number).toBeGreaterThan(0);

    // 4. Meta: the conversation and its draft are gone
    const social = await withAdmin(async (cl) => ({
      events: Number(
        (
          await cl.query('SELECT count(*)::int n FROM social_events WHERE tenant_id = $1', [
            s.tenantId,
          ])
        ).rows[0].n,
      ),
      drafts: Number(
        (
          await cl.query('SELECT count(*)::int n FROM social_drafts WHERE tenant_id = $1', [
            s.tenantId,
          ])
        ).rows[0].n,
      ),
    }));
    expect(social).toEqual({ events: 0, drafts: 0 });

    // 5. the audit trail has one entry, with ids and counts only (the reason has the customer's name taken out)
    const audit = (await s.api.get('/v1/audit-logs?limit=100').expect(200)).body.items as {
      action: string;
      targetId: string;
      metadata: Record<string, unknown>;
    }[];
    const entries = audit.filter((e) => e.action === 'customer.erased');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ targetId: id });
    expect(entries[0]!.metadata).toMatchObject({ orders: 3, addresses: 2 });
    expect(JSON.stringify(entries[0]!.metadata)).not.toMatch(/Rahim|Uddin|1712345678/);
    expect(entries[0]!.metadata['reason']).toBe('Customer [erased] asked by phone');
  });

  it('answers the same when repeated, and records it once', async () => {
    const s = await shop();
    await order(s, RAHIM, 'cancelled');
    const id = await customerIdOf(s, RAHIM.phone);
    const first = await erase(s.api, id).expect(200);
    const second = await erase(s.api, id).expect(200);
    expect(second.body).toEqual(first.body);
    const audit = (await s.api.get('/v1/audit-logs?limit=100').expect(200)).body.items as {
      action: string;
    }[];
    expect(audit.filter((e) => e.action === 'customer.erased')).toHaveLength(1);
  });

  it('frees the phone number: the same number can be a new customer, and an erased customer cannot be changed or ordered for', async () => {
    const s = await shop();
    await order(s, RAHIM, 'cancelled');
    const id = await customerIdOf(s, RAHIM.phone);
    await erase(s.api, id).expect(200);

    const again = await s.api
      .post('/v1/customers', { name: 'New Rahim', phone: RAHIM.phone })
      .expect(201);
    expect(again.body.id).not.toBe(id);
    expect(again.body.erasedAt).toBeNull();

    expect((await s.api.patch(`/v1/customers/${id}`, { name: 'Someone Else' })).status).toBe(409);
    expect(
      (
        await s.api.post(`/v1/customers/${id}/addresses`, {
          recipientName: 'X Y Z',
          phone: '01712345678',
          line1: 'Somewhere 1',
          area: 'A',
          district: 'Dhaka',
          division: 'Dhaka',
        })
      ).status,
    ).toBe(409);
    const refused = await s.api.post('/v1/orders', {
      customerId: id,
      address: addr(RAHIM),
      items: [{ variantId: s.variantId, quantity: 1 }],
      idempotencyKey: key('ord'),
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body.errors)).toContain('erased');
  });

  it('is left out of the customer export; the export has the others, in a spreadsheet-safe form', async () => {
    const s = await shop();
    await order(s, RAHIM, 'cancelled');
    await order(s, KARIM, 'delivered');
    const id = await customerIdOf(s, RAHIM.phone);
    const before = (await s.api.get('/v1/exports/customers').expect(200)).body;
    expect(before.rowCount).toBe(2);
    expect(before.csv).toContain('Rahim Uddin');
    await erase(s.api, id).expect(200);
    const after = (await s.api.get('/v1/exports/customers').expect(200)).body;
    expect(after.rowCount).toBe(1);
    expect(after.csv).not.toContain('Rahim');
    expect(after.csv).toContain('Karim Hossain');
    expect(after.csv.split('\r\n')[0]).toContain('delivered_value');
    expect(after.filename).toMatch(/^customers-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe('the database fence around the erase function', () => {
  it('only works inside the business the transaction is scoped to, and its helpers are not callable', async () => {
    const a = await shop();
    const b = await shop();
    await order(a, RAHIM, 'cancelled');
    const id = await customerIdOf(a, RAHIM.phone);
    // scoped to B, asking for A's customer: refused
    await expect(
      t.db.withContext(
        { tenantId: b.tenantId },
        (tx) => tx.$queryRaw`SELECT * FROM erase_customer(${a.tenantId}::uuid, ${id}::uuid, NULL)`,
      ),
    ).rejects.toThrow(/not scoped to this business/);
    // no scope at all: refused
    await expect(
      t.db.withContext(
        {},
        (tx) => tx.$queryRaw`SELECT * FROM erase_customer(${a.tenantId}::uuid, ${id}::uuid, NULL)`,
      ),
    ).rejects.toThrow(/not scoped to this business/);
    expect((await a.api.get(`/v1/customers/${id}`)).body.name).toBe(RAHIM.name);
    // the helpers are private to the owner role
    for (const sql of [
      "SELECT erasure_scrub_text('abc', 'a')",
      "SELECT erasure_phone_forms('01712345678')",
    ])
      await expect(t.db.withContext({}, (tx) => tx.$queryRawUnsafe(sql))).rejects.toThrow(
        /permission denied/,
      );
  });
});
