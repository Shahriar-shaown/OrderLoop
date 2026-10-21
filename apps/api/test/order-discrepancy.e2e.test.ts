import { fakeNetwork } from '@orderloop/courier-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProduct, createTestApp, registerTenant, type TestApp } from './app.js';
import { AuditService } from '../src/audit/audit.service.js';
import { uuidv7 } from '../src/common/uuid.js';
import { syncDiscrepancy } from '../src/finance/discrepancies.js';

/** Order status changes re-check the cash discrepancies of that order's settlement lines, with no "recheck" needed. */
let t: TestApp;
let net = fakeNetwork({});
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

const TOKEN = 'steadfast-token-0123456789';
let seq = 0;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const HEAD =
  'transaction_id,consignment_id,tracking_code,reference,phone,date,type,collected,delivery_charge,cod_fee,return_charge,other_deduction,net,note';

async function shop() {
  net = fakeNetwork({
    'POST /api/v1/create_order': (rec) => ({
      body: {
        status: 200,
        consignment: {
          consignment_id: 9000 + ++seq,
          invoice: (rec.body as { invoice: string }).invoice,
          tracking_code: `TRK${seq}`,
          status: 'in_review',
        },
      },
    }),
  });
  const owner = await registerTenant(t);
  const as = { Authorization: `Bearer ${owner.accessToken}` };
  const saved = await t.http
    .patch('/v1/couriers/steadfast')
    .set(as)
    .send({
      environment: 'production',
      credentials: { apiKey: 'k', secretKey: 's' },
      webhookSecret: TOKEN,
    })
    .expect(200);
  return { owner, as, hook: new URL(saved.body.connection.webhookUrl as string).pathname };
}

describe('order status changes and cash discrepancies', () => {
  it('opens and closes the cash-before-delivery problem as the order is moved, by hand or by the courier', async () => {
    const { owner, as, hook } = await shop();
    const post = (path: string, body: object = {}) => t.http.post(path).set(as).send(body);
    const parcel = async () => {
      const { variant } = await createProduct(t, owner.accessToken, { priceMinor: 100_000 });
      await post('/v1/inventory/receive', { variantId: variant.id, quantity: 5 }).expect(201);
      const order = await post('/v1/orders', {
        customer: { name: 'Rina Akter', phone: `0171${String(2000000 + ++seq).slice(-7)}` },
        address: {
          recipientName: 'Rina Akter',
          phone: '01712345678',
          line1: 'House 5, Road 3',
          area: 'Dhanmondi',
          district: 'Dhaka',
          division: 'Dhaka',
        },
        items: [{ variantId: variant.id, quantity: 1 }],
        deliveryChargeMinor: 6_000,
        idempotencyKey: `ord-${Date.now()}-${++seq}`,
        confirm: true,
      }).expect(201);
      await post(`/v1/orders/${order.body.id}/status`, { status: 'ready_to_ship' }).expect(200);
      const s = await post(`/v1/orders/${order.body.id}/shipments`, {
        provider: 'steadfast',
        idempotencyKey: `bk-${Date.now()}-${++seq}`,
      }).expect(201);
      for (const to of ['shipped', 'in_transit'])
        await post(`/v1/orders/${order.body.id}/status`, { status: to }).expect(200);
      return {
        id: order.body.id as string,
        number: order.body.orderNumber as number,
        consignment: s.body.consignmentId as string,
      };
    };
    const [byHand, byCourier] = [await parcel(), await parcel()];
    const d = today();
    await post('/v1/settlements/import', {
      provider: 'steadfast',
      fileName: 'statement.csv',
      csv: [
        HEAD,
        `,${byHand.consignment},,,,${d},cod,1060,0,0,0,0,,`,
        `,${byCourier.consignment},,,,${d},cod,1060,0,0,0,0,,`,
      ].join('\n'),
    }).expect(200);
    const open = async () =>
      (
        (await t.http.get('/v1/finance/discrepancies?status=open').set(as).expect(200)).body as {
          type: string;
          orderNumber: number | null;
        }[]
      )
        .map((x) => `${x.type}:${x.orderNumber}`)
        .sort();
    expect(await open()).toEqual(
      [`cash_before_delivery:${byHand.number}`, `cash_before_delivery:${byCourier.number}`].sort(),
    );

    // a person marks one delivered: its problem closes at once
    await post(`/v1/orders/${byHand.id}/status`, { status: 'delivered' }).expect(200);
    expect(await open()).toEqual([`cash_before_delivery:${byCourier.number}`]);

    // the courier's own news delivers the other
    await t.http
      .post(hook)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        notification_type: 'delivery_status',
        consignment_id: Number(byCourier.consignment),
        invoice: `OL-${byCourier.number}`,
        cod_amount: 1060,
        status: 'delivered',
        delivery_charge: 60,
        tracking_message: 'Delivered',
        updated_at: '2026-10-18 10:00:00',
      })
      .expect(200);
    expect(await open()).toEqual([]);
  });
});

describe('two evaluations racing to open the same discrepancy', () => {
  it('the second finds it already open instead of failing (and rolling back its own work)', async () => {
    const owner = await registerTenant(t);
    const tenantId = owner.tenant.id;
    const audit = t.app.get(AuditService);
    const subject = {
      type: 'short_paid' as const,
      subjectKey: `shipment:${uuidv7()}`,
      condition: { expectedMinor: 100, actualMinor: 50, message: 'Short' },
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const first = new Promise<void>((r) => (inserted = r));
    const a = t.db.withContext({ tenantId }, async (tx) => {
      const r = await syncDiscrepancy(tx, audit, tenantId, subject);
      inserted();
      await gate; // holds the new row uncommitted while the other evaluation runs
      return r;
    });
    await first;
    // The other evaluation cannot see the row yet, so it tries to create it too.
    const b = t.db.withContext({ tenantId }, async (tx) => {
      const r = await syncDiscrepancy(tx, audit, tenantId, subject);
      await audit.record(tx, { tenantId, action: 'test.after_discrepancy' }); // work that must not be rolled back
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.opened).toBe(1);
    expect(rb.opened).toBe(0);
    const rows = await t.db.withContext({ tenantId }, (tx) =>
      tx.discrepancy.findMany({ where: { tenantId, subjectKey: subject.subjectKey } }),
    );
    expect(rows).toHaveLength(1);
    const after = await t.db.withContext({ tenantId }, (tx) =>
      tx.auditLog.count({ where: { tenantId, action: 'test.after_discrepancy' } }),
    );
    expect(after).toBe(1);
  });
});
