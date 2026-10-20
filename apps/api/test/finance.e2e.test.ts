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
const importFile = (api: Api, csv: string, extra: object = {}) =>
  api.post('/v1/settlements/import', {
    provider: 'steadfast',
    csv,
    fileName: 'statement.csv',
    ...extra,
  });

const outstanding = async (api: Api) => (await api.get('/v1/finance/outstanding').expect(200)).body;
const batch = async (api: Api, id: string) =>
  (await api.get(`/v1/settlements/batches/${id}`).expect(200)).body;
const open = async (api: Api) =>
  (await api.get('/v1/finance/discrepancies?status=open').expect(200)).body as {
    type: string;
    orderNumber: number | null;
  }[];
const orderStatus = async (api: Api, id: string) =>
  (await api.get(`/v1/orders/${id}`)).body.status as string;

describe('the checkpoint: a fictional courier settlement', () => {
  it('identifies paid orders, missing remittances, duplicate entries and discrepancies', async () => {
    const { owner, api, hookPath } = await shop();
    const d = today();
    const paid = await booked(owner, api);
    const partial = await booked(owner, api);
    const missing = await booked(owner, api);
    const dup = await booked(owner, api);
    const early = await booked(owner, api);
    const closed = await booked(owner, api);
    const wrongNet = await booked(owner, api);
    const byNumber = await booked(owner, api);
    const conflictA = await booked(owner, api);
    const conflictB = await booked(owner, api);
    // delivered by the courier's own webhook
    for (const b of [paid, partial, missing, dup, wrongNet, byNumber, conflictA, conflictB])
      await deliver(hookPath, b);
    // `early` is still on its way; `closed` came back
    for (const to of ['shipped', 'in_transit'])
      await api.post(`/v1/orders/${early.id}/status`, { status: to }).expect(200);
    for (const [to, extra] of [
      ['shipped', {}],
      ['in_transit', {}],
      ['delivery_failed', { reason: 'Customer not home' }],
      ['return_requested', { reason: 'Customer refused' }],
    ] as const)
      await api.post(`/v1/orders/${closed.id}/status`, { status: to, ...extra }).expect(200);
    expect(await orderStatus(api, early.id)).toBe('in_transit');

    // before any statement: delivered orders are outstanding. Delivery is not proof of cash.
    let o = await outstanding(api);
    expect(o.outstandingMinor).toBe(8 * 106_000);
    expect(o.onTheWayMinor).toBe(106_000);

    const csv = file(
      // 1. paid in full, matched by the courier's consignment id
      `T1,${paid.consignmentId},,,,${d},cod,"1,060.00",60,10.60,0,0,989.40,`,
      // 2. partial: 500 of 1060, matched by our reference
      `T2,,,OL-${partial.number},,${d},cod,500,60,5,0,0,435,short remittance`,
      // 4. the same line twice (a courier's statement repeats a row)
      `,${dup.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`,
      `,${dup.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`,
      // 5. cash for an order that is not delivered
      `T5,${early.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`,
      // 6. cash for a returned order
      `T6,${closed.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`,
      // 7. the file's own net is wrong (1060 - 60 - 10.60 = 989.40, not 1000)
      `T7,${wrongNet.consignmentId},,,,${d},cod,1060,60,10.60,0,0,1000,`,
      // 8. matched by a bare order number, with the phone to corroborate
      `T8,,,#${byNumber.number},01712345678,${d},cod,1060,60,10.60,0,0,989.40,`,
      // 9. a parcel we never booked
      `T9,NOT-OURS-1,,,,${d},cod,700,60,7,0,0,,`,
      // 10. identifiers that disagree: one parcel's consignment id with another's reference
      `T10,${conflictA.consignmentId},,OL-${conflictB.number},,${d},cod,1060,60,10.60,0,0,,`,
      // 11. a monthly fee that belongs to no parcel
      `T11,,,,,${d},adjustment,0,0,0,0,25,,Monthly account fee`,
    );

    // a dry run changes nothing
    const dry = await importFile(api, csv, { dryRun: true }).expect(200);
    expect(dry.body).toMatchObject({
      dryRun: true,
      alreadyImported: false,
      rows: 11,
      counts: { matched: 7, unmatched: 1, ambiguous: 1, unallocated: 1, duplicate: 1 },
    });
    expect((await api.get('/v1/settlements/batches')).body).toEqual([]);

    const res = await importFile(api, csv).expect(200);
    const id = res.body.batchId as string;
    expect(res.body).toMatchObject({
      dryRun: false,
      alreadyImported: false,
      rows: 11,
      counts: { matched: 7, unmatched: 1, ambiguous: 1, unallocated: 1, duplicate: 1, ignored: 0 },
    });
    // counted money excludes the duplicate: seven lines of 1060.00, plus 500.00 and 700.00 = 8,620.00 collected;
    // the courier kept 7 x 70.60 + 65.00 + 67.00 + 25.00 = 651.20
    expect(res.body.totals).toEqual({
      collectedMinor: 862_000,
      chargesMinor: 65_120,
      netMinor: 796_880,
    });

    const b = await batch(api, id);
    const line = (n: number) => b.items.find((i: { lineNo: number }) => i.lineNo === n);
    expect(line(2)).toMatchObject({
      matchStatus: 'matched',
      matchMethod: 'consignment_id',
      orderNumber: paid.number,
      collectedMinor: 106_000,
      netMinor: 98_940,
    });
    expect(line(3)).toMatchObject({
      matchStatus: 'matched',
      matchMethod: 'reference',
      orderNumber: partial.number,
    });
    expect(line(4)).toMatchObject({ matchStatus: 'matched', orderNumber: dup.number });
    expect(line(5)).toMatchObject({ matchStatus: 'duplicate', duplicateOfId: line(4).id });
    expect(line(9)).toMatchObject({
      matchStatus: 'matched',
      matchMethod: 'order_number',
      orderNumber: byNumber.number,
    });
    expect(line(10)).toMatchObject({ matchStatus: 'unmatched' });
    expect(line(11)).toMatchObject({ matchStatus: 'ambiguous' });
    expect(line(12)).toMatchObject({ matchStatus: 'unallocated' });

    // paid orders are paid; the rest are not
    o = await outstanding(api);
    const rowFor = (n: number) => o.rows.find((r: { orderNumber: number }) => r.orderNumber === n);
    expect(rowFor(paid.number)).toBeUndefined(); // paid in full
    expect(rowFor(wrongNet.number)).toBeUndefined();
    expect(rowFor(byNumber.number)).toBeUndefined();
    expect(rowFor(dup.number)).toBeUndefined(); // the repeated line was not counted twice
    expect(rowFor(partial.number)).toMatchObject({
      state: 'partial',
      expectedMinor: 106_000,
      collectedMinor: 50_000,
      outstandingMinor: 56_000,
    });
    expect(rowFor(missing.number)).toMatchObject({
      state: 'unpaid',
      collectedMinor: 0,
      outstandingMinor: 106_000,
    }); // missing remittance
    expect(rowFor(conflictA.number)).toMatchObject({ state: 'unpaid' }); // an ambiguous line pays nobody
    expect(rowFor(conflictB.number)).toMatchObject({ state: 'unpaid' });
    expect(o.outstandingMinor).toBe(56_000 + 106_000 * 3);
    expect(o.deliveredCollectedMinor).toBe(106_000 * 4 + 50_000);

    // discrepancies, each said once and in plain words
    const found = (await open(api)).map((x) => `${x.type}:${x.orderNumber}`).sort();
    expect(found).toEqual(
      [
        `short_paid:${partial.number}`,
        `cash_before_delivery:${early.number}`,
        `cash_on_closed_order:${closed.number}`,
        `file_arithmetic:${wrongNet.number}`,
      ].sort(),
    );

    // the settlement is NOT reconciled, and cannot be made so
    expect(b).toMatchObject({ status: 'needs_attention', canReconcile: false, reconciledAt: null });
    const refused = await api.post(`/v1/settlements/batches/${id}/reconcile`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('settlement_has_issues');
    expect(refused.body.detail).toMatch(/not tied to any order/);

    // importing the same file again adds nothing, however many times
    const again = await importFile(api, csv).expect(200);
    expect(again.body).toMatchObject({ alreadyImported: true, batchId: id, rows: 11 });
    expect((await api.get('/v1/settlements/batches')).body).toHaveLength(1);
    expect((await batch(api, id)).items).toHaveLength(11);
    // so does the same statement saved differently (Windows line endings, a BOM, a trailing blank line)
    const resaved = await importFile(api, `﻿${csv.replace(/\n/g, '\r\n')}\r\n\r\n`).expect(200);
    expect(resaved.body).toMatchObject({ alreadyImported: true, batchId: id });
  });
});

describe('importing: idempotent, exact, refusing what it cannot read', () => {
  it('five identical uploads at once make one settlement', async () => {
    const { owner, api, hookPath } = await shop();
    const b = await booked(owner, api);
    await deliver(hookPath, b);
    const csv = file(`,${b.consignmentId},,,,${today()},cod,1060,60,10.60,0,0,,`);
    const results = await Promise.all(Array.from({ length: 5 }, () => importFile(api, csv)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results.filter((r) => !r.body.alreadyImported)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.batchId)).size).toBe(1);
    const batches = (await api.get('/v1/settlements/batches')).body;
    expect(batches).toHaveLength(1);
    expect((await batch(api, batches[0].id)).items).toHaveLength(1);
    expect((await outstanding(api)).outstandingMinor).toBe(0);
  });

  it('overlapping statements imported at once never fail: each line is counted once, whichever lands first', async () => {
    const { owner, api, hookPath } = await shop();
    const parcels = [await booked(owner, api), await booked(owner, api), await booked(owner, api)];
    for (const p of parcels) await deliver(hookPath, p);
    const d = today();
    const line = (p: (typeof parcels)[number]) =>
      `,${p.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`;
    const results = await Promise.all([
      importFile(api, file(line(parcels[0]!), line(parcels[1]!)), { fileName: 'one.csv' }),
      importFile(api, file(line(parcels[1]!), line(parcels[2]!)), { fileName: 'two.csv' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await Promise.all(
      (await api.get('/v1/settlements/batches')).body.map((x: { id: string }) => batch(api, x.id)),
    );
    const items = rows.flatMap((r) => r.items as { matchStatus: string; reference: string }[]);
    expect(items).toHaveLength(4);
    // three distinct lines are counted, the shared one is the single duplicate
    expect(items.filter((i) => i.matchStatus === 'duplicate')).toHaveLength(1);
  });

  it('a different file that repeats earlier lines records them once: the repeats are flagged, not counted', async () => {
    const { owner, api, hookPath } = await shop();
    const [a, b] = [await booked(owner, api), await booked(owner, api)];
    await deliver(hookPath, a);
    await deliver(hookPath, b);
    const d = today();
    const lineA = `,${a.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`;
    const first = (await importFile(api, file(lineA)).expect(200)).body;
    const second = (
      await importFile(api, file(lineA, `,${b.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`), {
        fileName: 'bigger.csv',
      }).expect(200)
    ).body;
    expect(second.alreadyImported).toBe(false);
    expect(second.counts).toMatchObject({ duplicate: 1, matched: 1 });
    expect(second.totals.collectedMinor).toBe(106_000); // only the new line
    const detail = await batch(api, second.batchId);
    expect(detail.items[0]).toMatchObject({ matchStatus: 'duplicate' });
    expect((await outstanding(api)).outstandingMinor).toBe(0);
    // the first settlement is untouched
    expect((await batch(api, first.batchId)).counts.matched).toBe(1);
    // a courier's own transaction id tells two identical-looking lines apart
    const c = await booked(owner, api);
    await deliver(hookPath, c);
    const twins = (
      await importFile(
        api,
        file(
          `TX-1,${c.consignmentId},,,,${d},cod,500,0,0,0,0,,`,
          `TX-2,${c.consignmentId},,,,${d},cod,500,0,0,0,0,,`,
        ),
      ).expect(200)
    ).body;
    expect(twins.counts).toMatchObject({ matched: 2, duplicate: 0 });
  });

  it('refuses a file with any bad line, naming each, and records nothing', async () => {
    const { api } = await shop();
    const d = today();
    const bad = await importFile(
      api,
      file(
        `,C1,,,,${d},cod,10,0,0,0,0,,`,
        `,C2,,,,31/02/2026,cod,10,0,0,0,0,,`,
        `,C3,,,,${d},cod,-5,0,0,0,0,,`,
        `,C4,,,,${d},cod,1.234,0,0,0,0,,`,
      ),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual([
      'line 3',
      'line 4',
      'line 5',
    ]);
    expect((await api.get('/v1/settlements/batches')).body).toEqual([]);
    expect((await importFile(api, 'date,bogus\n2026-01-01,1')).status).toBe(400);
    expect(
      (
        await api.post('/v1/settlements/import', {
          provider: 'mock',
          csv: file(`,C1,,,,${d},cod,10,0,0,0,0,,`),
        })
      ).status,
    ).toBe(400); // simulated couriers move no money
  });

  it('keeps every paisa: amounts are read as decimals, never floats', async () => {
    const { owner, api, hookPath } = await shop();
    const b = await booked(owner, api);
    await deliver(hookPath, b);
    const res = await importFile(
      api,
      file(`,${b.consignmentId},,,,${today()},cod,"1,060.00",60,10.29,0.07,0.01,989.63,`),
    ).expect(200);
    expect(res.body.totals).toEqual({
      collectedMinor: 106_000,
      chargesMinor: 6_000 + 1_029 + 7 + 1,
      netMinor: 106_000 - 7_037,
    });
    const detail = await batch(api, res.body.batchId);
    expect(detail.items[0]).toMatchObject({
      collectedMinor: 106_000,
      deliveryChargeMinor: 6_000,
      codFeeMinor: 1_029,
      returnChargeMinor: 7,
      otherDeductionMinor: 1,
      netMinor: 98_963,
    });
    expect(detail.openDiscrepancies).toBe(0);
  });
});

describe('manual decisions, reconciliation and the audit trail', () => {
  it('a settlement is reconciled only when everything is settled, and every manual decision is on record', async () => {
    const { owner, api, hookPath } = await shop();
    const accountant = await addMember(t, owner, 'ACCOUNTANT');
    const manager = await addMember(t, owner, 'MANAGER');
    const acct = call(accountant);
    const [a, short, stray] = [
      await booked(owner, api),
      await booked(owner, api),
      await booked(owner, api),
    ];
    for (const x of [a, short, stray]) await deliver(hookPath, x);
    const d = today();
    const res = await importFile(
      acct,
      file(
        `,${a.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`,
        `,${short.consignmentId},,,,${d},cod,400,60,4,0,0,,`,
        `,TYPO-77,,,,${d},cod,1060,60,10.60,0,0,,`,
        `,,,,,${d},adjustment,0,0,0,0,25,,Monthly fee`,
      ),
    ).expect(200); // an accountant may import
    const id = res.body.batchId as string;
    let b = await batch(api, id);
    expect(b.counts).toMatchObject({ matched: 2, unmatched: 1, unallocated: 1 });
    const itemOf = (n: number) => b.items.find((i: { lineNo: number }) => i.lineNo === n);

    // who may do what
    const stranger = itemOf(4);
    expect(
      (
        await acct.post(`/v1/settlements/items/${stranger.id}/match`, {
          shipmentId: stray.shipmentId,
          reason: 'Courier typo',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(manager).post('/v1/settlements/import', {
          provider: 'steadfast',
          csv: file(`,X,,,,${d},cod,1,0,0,0,0,,`),
        })
      ).status,
    ).toBe(403);
    expect((await call(manager).get('/v1/settlements/batches')).status).toBe(200);
    const staff = await addMember(t, owner, 'STAFF');
    expect((await call(staff).get('/v1/finance/outstanding')).status).toBe(403);
    expect(
      (
        await acct.post('/v1/finance/costs', {
          kind: 'packaging',
          amountMinor: 100,
          incurredOn: d,
          note: 'Boxes',
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(403);

    // a match by hand needs a reason, and only to this courier's own real parcel
    expect(
      (
        await api.post(`/v1/settlements/items/${stranger.id}/match`, {
          shipmentId: stray.shipmentId,
          reason: 'x',
        })
      ).status,
    ).toBe(400);
    const matched = await api
      .post(`/v1/settlements/items/${stranger.id}/match`, {
        shipmentId: stray.shipmentId,
        reason: 'Courier mistyped the consignment id',
      })
      .expect(200);
    expect(matched.body).toMatchObject({
      matchStatus: 'matched',
      matchMethod: 'manual',
      orderNumber: stray.number,
    });
    expect(matched.body.history.map((h: { action: string }) => h.action)).toEqual([
      'imported',
      'unmatched',
      'manual_matched',
    ]);
    expect(matched.body.history.at(-1)).toMatchObject({
      actorName: expect.any(String),
      note: expect.stringContaining('Courier mistyped'),
    });
    expect(
      (
        await api.post(`/v1/settlements/items/${stranger.id}/match`, {
          shipmentId: a.shipmentId,
          reason: 'again',
        })
      ).status,
    ).toBe(409); // already matched: undo first

    // the shortfall stays until a person accepts it. Delivery does not clear it.
    const shortfall = (await open(api)).filter((x) => x.type === 'short_paid');
    expect(shortfall).toHaveLength(1);
    let r = await api.post(`/v1/settlements/batches/${id}/reconcile`);
    expect(r.status).toBe(409);
    const list = (await api.get('/v1/finance/discrepancies?status=open')).body as {
      id: string;
      type: string;
    }[];
    const shortId = list.find((x) => x.type === 'short_paid')!.id;
    expect(
      (
        await acct.post(`/v1/finance/discrepancies/${shortId}/resolve`, {
          action: 'waive',
          note: 'Accepted',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.post(`/v1/finance/discrepancies/${shortId}/resolve`, {
          action: 'waive',
          note: 'x',
        })
      ).status,
    ).toBe(400);
    const waived = await api
      .post(`/v1/finance/discrepancies/${shortId}/resolve`, {
        action: 'waive',
        note: 'Courier confirmed the rest was lost',
      })
      .expect(200);
    expect(waived.body).toMatchObject({
      status: 'waived',
      resolution: 'Courier confirmed the rest was lost',
    });
    expect(
      (
        await api.post(`/v1/finance/discrepancies/${shortId}/resolve`, {
          action: 'resolve',
          note: 'again please',
        })
      ).status,
    ).toBe(409);

    // nothing open: now it can be reconciled, by an accountant
    b = await batch(api, id);
    expect(b).toMatchObject({ canReconcile: true, status: 'ready', issues: [] });
    const done = await acct.post(`/v1/settlements/batches/${id}/reconcile`).expect(200);
    expect(done.body).toMatchObject({ status: 'reconciled', reconciledAt: expect.any(String) });
    // doing it again changes nothing
    expect(
      (await acct.post(`/v1/settlements/batches/${id}/reconcile`).expect(200)).body.reconciledAt,
    ).toBe(done.body.reconciledAt);

    // the waived shortfall is a loss in the books, and outstanding COD no longer lists it as owed to us by mistake
    const summary = (await api.get(`/v1/finance/summary?from=${d}&to=${d}`).expect(200)).body;
    expect(
      summary.figures.find((f: { key: string }) => f.key === 'cod_written_off').amountMinor,
    ).toBe(106_000 - 40_000);

    // undoing a match reopens it: the settlement is no longer reconciled
    const undone = await api
      .post(`/v1/settlements/items/${stranger.id}/unmatch`, { reason: 'Wrong parcel after all' })
      .expect(200);
    expect(undone.body.matchStatus).toBe('unmatched');
    expect((await batch(api, id)).status).toBe('needs_attention');
    // an unmatched line that is not ours can be set aside, with a reason, and counts in no figure
    await api
      .post(`/v1/settlements/items/${stranger.id}/ignore`, { reason: 'Belongs to another shop' })
      .expect(200);
    const fee = itemOf(5);
    await api
      .post(`/v1/settlements/items/${fee.id}/ignore`, { reason: 'Account fee is booked elsewhere' })
      .expect(200);
    b = await batch(api, id);
    expect(b.counts).toMatchObject({ ignored: 2, unmatched: 0 });
    expect(b.totals.collectedMinor).toBe(106_000 + 40_000); // ignored lines are in no total
    // the full history of a line is kept
    const history = (
      await api.get(`/v1/settlements/items/${stranger.id}`).expect(200)
    ).body.history.map((h: { action: string }) => h.action);
    expect(history).toEqual(['imported', 'unmatched', 'manual_matched', 'unmatched', 'ignored']);
    // and the audit trail names the people
    const audit = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: owner.tenant.id, action: { startsWith: 'settlement.' } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audit.map((x) => x.action)).toEqual(
      expect.arrayContaining([
        'settlement.imported',
        'settlement.item_manual_matched',
        'settlement.reconciled',
        'settlement.item_unmatched',
        'settlement.item_ignored',
      ]),
    );
    expect(audit.find((x) => x.action === 'settlement.item_manual_matched')!.actorUserId).toBe(
      owner.user.id,
    );
  });

  it('cash that arrives later clears a shortfall, and a delivered order clears "cash before delivery", by themselves', async () => {
    const { owner, api, hookPath } = await shop();
    const [p, early] = [await booked(owner, api), await booked(owner, api)];
    await deliver(hookPath, p);
    for (const to of ['shipped', 'in_transit'])
      await api.post(`/v1/orders/${early.id}/status`, { status: to }).expect(200);
    const d = today();
    await importFile(
      api,
      file(
        `,${p.consignmentId},,,,${d},cod,400,0,0,0,0,,`,
        `,${early.consignmentId},,,,${d},cod,1060,0,0,0,0,,`,
      ),
    ).expect(200);
    expect((await open(api)).map((x) => x.type).sort()).toEqual([
      'cash_before_delivery',
      'short_paid',
    ]);
    expect((await outstanding(api)).outstandingMinor).toBe(66_000);
    // the rest of the cash arrives on a later statement
    const second = await importFile(api, file(`,${p.consignmentId},,,,${d},cod,660,0,0,0,0,,`), {
      fileName: 'second.csv',
    }).expect(200);
    expect(second.body.discrepancies).toBe(0); // this statement closed the shortfall; the other order's issue belongs to the first statement
    expect((await open(api)).map((x) => x.type)).toEqual(['cash_before_delivery']);
    expect((await outstanding(api)).outstandingMinor).toBe(0);
    // the other parcel is delivered: re-checking closes its discrepancy
    await deliver(hookPath, early);
    await api.post('/v1/finance/recheck').expect(200); // a status change may already have closed it; re-checking is safe either way
    expect(await open(api)).toEqual([]);
    expect((await batch(api, second.body.batchId)).status).toBe('ready');
  });

  it('a later statement that overpays reopens an already reconciled settlement', async () => {
    const { owner, api, hookPath } = await shop();
    const p = await booked(owner, api);
    await deliver(hookPath, p);
    const d = today();
    const first = await importFile(
      api,
      file(`,${p.consignmentId},,,,${d},cod,1060,0,0,0,0,,`),
    ).expect(200);
    await api.post(`/v1/settlements/batches/${first.body.batchId}/reconcile`).expect(200);
    expect((await batch(api, first.body.batchId)).status).toBe('reconciled');
    await importFile(api, file(`,${p.consignmentId},,,,${d},cod,100,0,0,0,0,,`), {
      fileName: 'extra.csv',
    }).expect(200);
    expect((await open(api)).map((x) => x.type)).toEqual(['over_paid']);
    expect((await batch(api, first.body.batchId)).status).toBe('needs_attention');
  });
});

describe('profit and the figures behind it', () => {
  it('works out sales, revenue, cash, outstanding COD, expenses and estimated profit separately, each with its source', async () => {
    const { owner, api, hookPath } = await shop();
    const d = today();
    // two delivered orders (cost 600 each), one still in transit, one never delivered
    const [a, b, inTransit] = [
      await booked(owner, api, { cost: 60_000 }),
      await booked(owner, api, { cost: 60_000 }),
      await booked(owner, api, { cost: 60_000 }),
    ];
    await deliver(hookPath, a);
    await deliver(hookPath, b);
    for (const to of ['shipped', 'in_transit'])
      await api.post(`/v1/orders/${inTransit.id}/status`, { status: to }).expect(200);
    // a cancelled order is sales that never happened
    const gone = await api
      .post('/v1/orders', {
        customer: { name: 'X Y', phone: '01799999991' },
        address: {
          recipientName: 'X Y',
          phone: '01799999991',
          line1: 'House 1',
          area: 'Gulshan',
          district: 'Dhaka',
          division: 'Dhaka',
        },
        items: [{ variantId: a.variantId, quantity: 2 }],
        idempotencyKey: key('ord'),
      })
      .expect(201);
    await api
      .post(`/v1/orders/${gone.body.id}/status`, { status: 'cancelled', reason: 'Changed mind' })
      .expect(200);

    // statement: a paid in full, b paid in full; courier keeps 60 + 10.60 on each. One return charge on a parcel that came back.
    await importFile(
      api,
      file(
        `,${a.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`,
        `,${b.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`,
        `,,,,,${d},adjustment,0,0,0,0,25,,Monthly fee`,
      ),
    ).expect(200);
    await api
      .post('/v1/finance/costs', {
        kind: 'packaging',
        amountMinor: 5_000,
        incurredOn: d,
        note: 'Boxes',
        idempotencyKey: key(),
      })
      .expect(201);
    await api
      .post('/v1/finance/costs', {
        kind: 'advertising',
        amountMinor: 10_000,
        incurredOn: d,
        note: 'Facebook boost',
        idempotencyKey: key(),
      })
      .expect(201);

    const s = (await api.get(`/v1/finance/summary?from=${d}&to=${d}`).expect(200)).body;
    const f = (k: string) => s.figures.find((x: { key: string }) => x.key === k);
    // sales: three real orders of 1060 (the cancelled one is excluded and reported on its own)
    expect(f('sales').amountMinor).toBe(3 * 106_000);
    expect(f('cancelled').amountMinor).toBe(2 * 100_000);
    expect(f('sales').source).toBe('orders');
    // revenue only for what was delivered: goods 2 x 1000, delivery billed 2 x 60
    expect(f('revenue_goods').amountMinor).toBe(200_000);
    expect(f('revenue_delivery').amountMinor).toBe(12_000);
    // cash is what the statements report, nothing else
    expect(f('cash_collected')).toMatchObject({ amountMinor: 212_000, source: 'settlements' });
    expect(f('cash_net').amountMinor).toBe(212_000 - 2 * 6_000 - 2 * 1_060);
    // outstanding COD excludes the parcel still on its way, which is shown on its own
    expect(f('outstanding_cod').amountMinor).toBe(0);
    expect(f('cod_on_the_way').amountMinor).toBe(106_000);
    // expenses, each with its own source
    expect(f('cogs')).toMatchObject({ amountMinor: 120_000, source: 'catalog_costs' });
    expect(f('courier_delivery')).toMatchObject({ amountMinor: 12_000, source: 'settlements' });
    expect(f('courier_cod_fee').amountMinor).toBe(2_120);
    expect(f('courier_other').amountMinor).toBe(2_500);
    expect(f('manual_costs')).toMatchObject({ amountMinor: 15_000, source: 'manual_costs' });
    // profit = (200000 + 12000) - 120000 - (12000 + 2120 + 0 + 2500) - 15000 = 60380
    expect(s.estimatedProfitMinor).toBe(212_000 - 120_000 - 16_620 - 15_000);
    expect(s.estimatedProfitMinor).toBe(60_380);
    expect(f('estimated_profit')).toMatchObject({
      amountMinor: 60_380,
      source: 'derived',
      group: 'profit',
    });
    expect(s.profitWithheldReason).toBeNull();
    // every figure says where it came from
    for (const fig of s.figures) {
      expect(fig.note.length).toBeGreaterThan(10);
      expect(['orders', 'settlements', 'manual_costs', 'catalog_costs', 'derived']).toContain(
        fig.source,
      );
    }
    // voiding a cost takes it out; costs are never deleted
    const costs = (await api.get(`/v1/finance/costs?from=${d}&to=${d}`)).body as { id: string }[];
    expect(costs).toHaveLength(2);
    await api
      .post(`/v1/finance/costs/${costs[0]!.id}/void`, { reason: 'Entered twice' })
      .expect(200);
    const s2 = (await api.get(`/v1/finance/summary?from=${d}&to=${d}`)).body;
    expect(
      s2.figures.find((x: { key: string }) => x.key === 'manual_costs').amountMinor,
    ).toBeLessThan(15_000);
    expect(
      (await api.post(`/v1/finance/costs/${costs[0]!.id}/void`, { reason: 'twice over' })).status,
    ).toBe(409);
  });

  it('cancelled and returned orders are not revenue, owe no COD, and a return charge is a cost', async () => {
    const { owner, api, hookPath } = await shop();
    const d = today();
    const kept = await booked(owner, api, { cost: 60_000 });
    const returned = await booked(owner, api, { cost: 60_000 });
    await deliver(hookPath, kept);
    await deliver(hookPath, returned);
    // the second one comes back: delivered, then a return is requested
    await api
      .post(`/v1/orders/${returned.id}/status`, {
        status: 'return_requested',
        reason: 'Customer sent it back',
      })
      .expect(200);
    await importFile(
      api,
      file(
        `,${kept.consignmentId},,,,${d},cod,1060,60,10.60,0,0,,`,
        `,${returned.consignmentId},,,,${d},return,0,0,0,50,0,,Returned parcel`,
      ),
    ).expect(200);
    const s = (await api.get(`/v1/finance/summary?from=${d}&to=${d}`).expect(200)).body;
    const f = (k: string) => s.figures.find((x: { key: string }) => x.key === k);
    expect(f('revenue_goods').amountMinor).toBe(100_000); // only the order that stayed delivered
    expect(f('cogs').amountMinor).toBe(60_000);
    expect(f('sales').amountMinor).toBe(2 * 106_000); // both were placed; a return is not a cancellation
    expect(f('courier_return').amountMinor).toBe(5_000); // the return charge is a real cost, even though nothing was delivered
    expect(f('outstanding_cod').amountMinor).toBe(0); // the returned order owes nothing
    // revenue 1000 + 60 billed - cost 600 - (60 + 10.60 + 50) = 329.40
    expect(s.estimatedProfitMinor).toBe(100_000 + 6_000 - 60_000 - (6_000 + 1_060 + 5_000));
    expect(await open(api)).toEqual([]);
  });

  it('shows no profit when a delivered line has no cost price, and says why', async () => {
    const { owner, api, hookPath } = await shop();
    const a = await booked(owner, api); // no cost price
    await deliver(hookPath, a);
    const d = today();
    const s = (await api.get(`/v1/finance/summary?from=${d}&to=${d}`).expect(200)).body;
    expect(s.estimatedProfitMinor).toBeNull();
    expect(s.profitWithheldReason).toMatch(/no cost price/);
    expect(s.figures.find((x: { key: string }) => x.key === 'estimated_profit')).toBeUndefined();
    expect(s.figures.find((x: { key: string }) => x.key === 'revenue_goods').amountMinor).toBe(
      100_000,
    );
  });

  it('refuses a date that is not on the calendar with 400, in finance and order filters', async () => {
    const { api } = await shop();
    for (const bad of ['2026-13-45', '2026-02-30', '2026-00-10'])
      for (const path of ['/v1/finance/summary', '/v1/finance/costs', '/v1/orders'])
        expect((await api.get(`${path}?from=${bad}`)).status).toBe(400);
    expect((await api.get('/v1/finance/summary?from=2028-02-29&to=2028-03-01')).status).toBe(200);
  });

  it('records a cost once however often the request is repeated, and refuses a reused key for a different cost', async () => {
    const { api } = await shop();
    const k = key('cost');
    const body = {
      kind: 'packaging',
      amountMinor: 7_500,
      incurredOn: today(),
      note: 'Bubble wrap',
      idempotencyKey: k,
    };
    const rs = await Promise.all(
      Array.from({ length: 4 }, () => api.post('/v1/finance/costs', body)),
    );
    expect(rs.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    for (const r of rs) expect([201, 409]).toContain(r.status);
    expect((await api.get('/v1/finance/costs')).body).toHaveLength(1);
    expect((await api.post('/v1/finance/costs', { ...body, amountMinor: 9_999 })).status).toBe(409);
    expect(
      (await api.post('/v1/finance/costs', { ...body, amountMinor: 0, idempotencyKey: key() }))
        .status,
    ).toBe(400);
  });
});

describe('isolation and the database as the last line of defence', () => {
  it('keeps one business’s statements, discrepancies and costs from another, and the same file is separate per business', async () => {
    const a = await shop();
    const bz = await shop();
    const p = await booked(a.owner, a.api);
    await deliver(a.hookPath, p);
    const csv = file(`,${p.consignmentId},,,,${today()},cod,500,0,0,0,0,,`);
    const res = await importFile(a.api, csv).expect(200);
    const detail = await batch(a.api, res.body.batchId);
    expect((await bz.api.get(`/v1/settlements/batches/${res.body.batchId}`)).status).toBe(404);
    expect((await bz.api.get(`/v1/settlements/items/${detail.items[0].id}`)).status).toBe(404);
    expect(
      (
        await bz.api.post(`/v1/settlements/items/${detail.items[0].id}/ignore`, {
          reason: 'not mine',
        })
      ).status,
    ).toBe(404);
    expect((await bz.api.get('/v1/finance/discrepancies')).body).toEqual([]);
    expect((await bz.api.get('/v1/settlements/unmatched')).body).toEqual([]);
    // the other business importing the very same file gets its own settlement, its parcels unmatched
    const theirs = await importFile(bz.api, csv).expect(200);
    expect(theirs.body.alreadyImported).toBe(false);
    expect(theirs.body.counts).toMatchObject({ unmatched: 1, matched: 0 });
    // and cannot tie a line to the first business's parcel
    const mine = (await batch(bz.api, theirs.body.batchId)).items[0];
    expect(
      (
        await bz.api.post(`/v1/settlements/items/${mine.id}/match`, {
          shipmentId: p.shipmentId,
          reason: 'trying',
        })
      ).status,
    ).toBe(404);
  });

  it('the database refuses a duplicate line, a sum that does not add up, and any deletion', async () => {
    const { owner, api, hookPath, tenantId } = await shop();
    const p = await booked(owner, api);
    await deliver(hookPath, p);
    const res = await importFile(
      api,
      file(`,${p.consignmentId},,,,${today()},cod,1060,60,10.60,0,0,,`),
    ).expect(200);
    const item = (await batch(api, res.body.batchId)).items[0];
    const ctx = { tenantId, userId: owner.user.id };
    const row = await t.db.withContext(ctx, (tx) =>
      tx.settlementItem.findFirstOrThrow({ where: { id: item.id } }),
    );
    const clone = { ...row, id: undefined, lineNo: 99 } as never;
    delete (clone as { id?: string }).id;
    // the same line again, not marked duplicate
    await expect(
      t.db.withContext(ctx, (tx) =>
        tx.settlementItem.create({ data: { ...(clone as object), raw: {} } as never }),
      ),
    ).rejects.toThrow();
    // a net that is not collected less charges
    await expect(
      t.db.withContext(ctx, (tx) =>
        tx.settlementItem.update({ where: { id: item.id }, data: { netMinor: 1 } }),
      ),
    ).rejects.toThrow();
    // a negative amount
    await expect(
      t.db.withContext(ctx, (tx) =>
        tx.settlementItem.update({
          where: { id: item.id },
          data: { collectedMinor: -1, netMinor: -1 - 7_060 },
        }),
      ),
    ).rejects.toThrow();
    // financial records are never deleted, and a line's history is never rewritten
    await expect(
      t.db.withContext(ctx, (tx) => tx.settlementItem.delete({ where: { id: item.id } })),
    ).rejects.toThrow();
    await expect(
      t.db.withContext(ctx, (tx) => tx.settlementBatch.delete({ where: { id: res.body.batchId } })),
    ).rejects.toThrow();
    await expect(
      t.db.withContext(ctx, (tx) =>
        tx.settlementItemEvent.deleteMany({ where: { itemId: item.id } }),
      ),
    ).rejects.toThrow();
    await expect(
      t.db.withContext(ctx, (tx) =>
        tx.settlementItemEvent.updateMany({
          where: { itemId: item.id },
          data: { note: 'rewritten' },
        }),
      ),
    ).rejects.toThrow();
    // nothing changed
    const after = await t.db.withContext(ctx, (tx) =>
      tx.settlementItem.findFirstOrThrow({ where: { id: item.id } }),
    );
    expect(after.collectedMinor).toBe(106_000);
    expect(after.netMinor).toBe(98_940);
  });
});
