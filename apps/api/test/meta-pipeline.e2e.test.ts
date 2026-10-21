import { randomUUID } from 'node:crypto';
import {
  processSocialEvent,
  sampleNotification,
  signedWebhook,
  sweepReceivedSocialEvents,
  type SampleMessage,
} from '@orderloop/automation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetaWebhookService } from '../src/meta/webhook.service.js';
import { bearer, createProduct, createTestApp, registerTenant, type TestApp } from './app.js';
import { drain, fakeQueue, type FakeQueue } from './automation-helpers.js';

const SECRET = 'test-app-secret-0123456789';
const VERIFY = 'test-verify-token-0123456789';

let t: TestApp;
let queue: FakeQueue;
beforeAll(async () => {
  queue = fakeQueue();
  // Mock mode WITH an app secret: the real, signed webhook route is live, and mock connections stand in for Pages.
  t = await createTestApp(
    { META_MODE: 'mock', META_APP_SECRET: SECRET, META_WEBHOOK_VERIFY_TOKEN: VERIFY },
    { meta: { events: queue } },
  );
});
afterAll(() => t.close());

type Owner = Awaited<ReturnType<typeof registerTenant>>;
const api = (o: { accessToken: string }) => ({
  get: (p: string) => t.http.get(p).set(bearer(o.accessToken)),
  post: (p: string, b: object = {}) => t.http.post(p).set(bearer(o.accessToken)).send(b),
  patch: (p: string, b: object) => t.http.patch(p).set(bearer(o.accessToken)).send(b),
});

/** A business with a mock Page, a product with stock and its own queue. */
async function shop(provider: 'facebook_page' | 'instagram' = 'facebook_page') {
  const owner = await registerTenant(t);
  const a = api(owner);
  const conn = (await a.post('/v1/integrations/meta/mock/connection', { provider }).expect(201))
    .body as {
    id: string;
    externalId: string;
  };
  const { variant } = await createProduct(t, owner.accessToken, {
    name: 'Cotton T-Shirt',
    sku: `TEE-${randomUUID().slice(0, 6).toUpperCase()}`,
    priceMinor: 120_000,
  });
  await a.post('/v1/inventory/receive', { variantId: variant.id, quantity: 20 }).expect(201);
  return { owner, a, conn, variant: variant as { id: string; sku: string } };
}

let seq = 0;
const mid = () => `m_${randomUUID()}`;
const sender = () => `PSID${++seq}${Date.now()}`;

/** POST a correctly signed notification to the REAL webhook route. */
const deliver = (
  conn: { externalId: string },
  messages: SampleMessage[],
  opts: {
    object?: 'page' | 'instagram';
    secret?: string;
    escaped?: boolean;
    accountId?: string;
  } = {},
) => {
  const { body, headers } = signedWebhook(
    sampleNotification(opts.object ?? 'page', opts.accountId ?? conn.externalId, messages),
    opts.secret ?? SECRET,
    opts.escaped,
  );
  return t.http.post('/v1/webhooks/meta').set(headers).send(body);
};

const events = (o: Owner) =>
  t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
    tx.socialEvent.findMany({ where: { tenantId: o.tenant.id } }),
  );
const drafts = (o: Owner) =>
  t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
    tx.socialDraft.findMany({ where: { tenantId: o.tenant.id } }),
  );
const orderCount = (o: Owner) =>
  t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
    tx.order.count({ where: { tenantId: o.tenant.id } }),
  );

/** What the worker does: run every queued event job once. */
const runWorker = () =>
  drain(queue, (job) =>
    processSocialEvent(
      { db: t.db, log: () => undefined },
      job.data as { tenantId: string; eventId: string },
    ),
  );

const ORDER_TEXT = (sku: string) =>
  `Name: Rahim Uddin\nPhone: 01712-345678\nAddress: House 12, Road 5, Dhanmondi, Dhaka\n2 pcs ${sku}`;

describe('the webhook handshake', () => {
  it('answers the challenge only for the right mode and verify token', async () => {
    const ok = await t.http.get('/v1/webhooks/meta').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY,
      'hub.challenge': '1158201444',
    });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('1158201444');
    expect(ok.type).toBe('text/plain');
    for (const q of [
      {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token-0123456789',
        'hub.challenge': '1',
      },
      { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY.slice(0, -1), 'hub.challenge': '1' },
      { 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '1' },
      { 'hub.mode': 'subscribe', 'hub.challenge': '1' },
      { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY },
      {},
    ]) {
      const r = await t.http.get('/v1/webhooks/meta').query(q);
      expect(r.status, JSON.stringify(q)).toBe(403);
      expect(r.text).not.toContain('1158201444');
    }
  });
});

describe('signature checking: nothing is read or stored without it', () => {
  it('rejects a missing, malformed, wrong-secret or tampered signature with 401 and stores nothing', async () => {
    const { owner, conn } = await shop();
    const msg: SampleMessage = { senderId: sender(), mid: mid(), text: '01712345678' };
    const good = signedWebhook(sampleNotification('page', conn.externalId, [msg]), SECRET);
    const attempts: [string, Record<string, string>, string][] = [
      ['no header', { 'content-type': 'application/json' }, good.body],
      ['junk header', { ...good.headers, 'x-hub-signature-256': 'sha256=zzz' }, good.body],
      [
        'sha1 header',
        { ...good.headers, 'x-hub-signature-256': 'sha1=' + 'a'.repeat(40) },
        good.body,
      ],
      ['wrong secret', signedWebhook({}, 'another-secret-0123456789').headers, good.body],
      ['tampered body', good.headers, good.body.replace('01712345678', '01812345678')],
      ['not even JSON, unsigned', { 'content-type': 'application/json' }, '{{{'],
    ];
    for (const [name, headers, body] of attempts) {
      const r = await t.http.post('/v1/webhooks/meta').set(headers).send(body);
      expect(r.status, name).toBe(401);
    }
    expect(await events(owner)).toHaveLength(0);
    expect(
      queue.pending().filter((j) => (j.data as { tenantId: string }).tenantId === owner.tenant.id),
    ).toHaveLength(0);
  });

  it('is 404 when the server has no Meta app secret at all (there is no such endpoint)', async () => {
    const service = new MetaWebhookService(t.db, { appSecret: null } as never, queue);
    const { body, headers } = signedWebhook({ object: 'page', entry: [] }, SECRET);
    await expect(
      service.receive(Buffer.from(body), headers['x-hub-signature-256']),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('accepts a payload with non-ASCII text signed in either form (raw bytes or escaped \\uXXXX)', async () => {
    const { owner, conn, variant } = await shop();
    for (const escaped of [false, true]) {
      const r = await deliver(
        conn,
        [{ senderId: sender(), mid: mid(), text: `আমি ২টা ${variant.sku} নিব 😀 ০১৭১২৩৪৫৬৭৮` }],
        { escaped },
      );
      expect(r.status, `escaped=${escaped}`).toBe(200);
      expect(r.body).toEqual({ status: 'ok' });
    }
    expect(await events(owner)).toHaveLength(2);
  });
});

describe('a signed webhook becomes a draft, then exactly one order', () => {
  it('stores the event, queues it, builds the draft, lets a person edit it and confirm it through the normal order path', async () => {
    const { owner, a, conn, variant } = await shop();
    const who = sender();
    const m = mid();
    const r = await deliver(conn, [{ senderId: who, mid: m, text: ORDER_TEXT(variant.sku) }]);
    expect(r.status).toBe(200);

    // stored before anything else, and queued under a deterministic id
    const stored = await events(owner);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      externalEventId: m,
      senderId: who,
      status: 'received',
      eventType: 'message',
    });
    expect(queue.jobs.has(`social-event__${stored[0]!.id}`)).toBe(true);
    expect(await drafts(owner)).toHaveLength(0); // the worker has not run

    await runWorker();
    const list = (await a.get('/v1/social-drafts').expect(200)).body;
    expect(list.mode).toBe('mock');
    expect(list.counts).toEqual({ needs_review: 1, confirmed: 0, dismissed: 0 });
    const summary = list.items[0];
    expect(summary).toMatchObject({
      status: 'needs_review',
      mock: true,
      provider: 'facebook_page',
      senderId: who,
      phone: '+8801712345678',
      itemCount: 1,
      unmatchedItemCount: 0,
    });

    const draft = (await a.get(`/v1/social-drafts/${summary.id}`).expect(200)).body;
    expect(draft.messages).toHaveLength(1);
    expect(draft.messages[0].text).toContain('Rahim Uddin');
    expect(draft.fields.customerName.value).toBe('Rahim Uddin');
    expect(draft.fields.address.value).toBe('House 12, Road 5, Dhanmondi, Dhaka');
    expect(draft.fields.district.value).toBe('Dhaka');
    expect(draft.suggestedDivision).toBe('Dhaka');
    expect(draft.fields.items[0]).toMatchObject({
      variantId: variant.id,
      quantity: 2,
      edited: false,
      match: { sku: variant.sku, priceMinor: 120_000, available: 20 },
    });
    expect(draft.warnings).toEqual([]);
    // list label: first 60 characters of the first message text; not confirmed yet, so no order number
    expect(draft.snippet).toBe(draft.messages[0].text.slice(0, 60));
    expect(draft.snippet.length).toBeLessThanOrEqual(60);
    expect(draft.orderNumber).toBeNull();
    expect(summary.snippet).toBe(draft.snippet);
    expect(draft.fields.area).toBeUndefined();
    expect(draft.fields.postalCode).toBeUndefined();

    // thana and postal code are typed by a person; null removes the edit; a bad postal code is refused
    const typed = (
      await a
        .patch(`/v1/social-drafts/${draft.id}`, { area: 'Dhanmondi', postalCode: '1209' })
        .expect(200)
    ).body;
    expect(typed.fields.area).toMatchObject({ value: 'Dhanmondi', edited: true, confidence: 1 });
    expect(typed.fields.postalCode).toMatchObject({ value: '1209', edited: true });
    await a.patch(`/v1/social-drafts/${draft.id}`, { postalCode: '12' }).expect(400);
    const cleared = (
      await a.patch(`/v1/social-drafts/${draft.id}`, { area: null, postalCode: null }).expect(200)
    ).body;
    expect(cleared.fields.area).toBeUndefined();
    expect(cleared.fields.postalCode).toBeUndefined();

    // a person corrects the quantity: the edit is kept
    const edited = (
      await a
        .patch(`/v1/social-drafts/${draft.id}`, {
          items: [{ variantId: variant.id, text: 'T-Shirt', quantity: 3 }],
          note: 'Call before delivery',
        })
        .expect(200)
    ).body;
    expect(edited.fields.items[0]).toMatchObject({ quantity: 3, edited: true });
    expect(edited.fields.note).toMatchObject({ value: 'Call before delivery', edited: true });
    await a.patch(`/v1/social-drafts/${draft.id}`, { phone: 'not a number' }).expect(400);
    await a
      .patch(`/v1/social-drafts/${draft.id}`, {
        items: [{ variantId: randomUUID(), text: 'x', quantity: 1 }],
      })
      .expect(400);

    // confirm: the same body as manual entry, with the idempotency key; confirm:true reserves stock exactly like a manual order
    const body = {
      customer: { name: 'Rahim Uddin', phone: '01712345678' },
      address: {
        recipientName: 'Rahim Uddin',
        phone: '01712345678',
        line1: 'House 12, Road 5, Dhanmondi',
        area: 'Dhanmondi',
        district: 'Dhaka',
        division: 'Dhaka',
      },
      items: [{ variantId: variant.id, quantity: 3 }],
      confirm: true,
      idempotencyKey: `draft-${randomUUID()}`,
    };
    const done = await a.post(`/v1/social-drafts/${draft.id}/confirm`, body);
    expect(done.status).toBe(200);
    // a MOCK draft makes an order with source 'other' (a real Page would be 'facebook', Instagram 'instagram')
    expect(done.body.order).toMatchObject({ status: 'confirmed', source: 'other' });
    expect(done.body.order.sourceReference).toMatch(/^mock facebook draft /);
    expect(done.body.order.items[0]).toMatchObject({ quantity: 3, unitPriceMinor: 120_000 });
    expect(done.body.draft).toMatchObject({
      status: 'confirmed',
      orderId: done.body.order.id,
      orderNumber: done.body.order.orderNumber,
    });
    const listed = (await a.get('/v1/social-drafts?status=confirmed').expect(200)).body;
    expect(listed.items[0]).toMatchObject({ orderNumber: done.body.order.orderNumber });
    const stock = (await a.get(`/v1/inventory?variantId=${variant.id}`)).body.items[0];
    expect(stock).toMatchObject({ onHand: 20, reserved: 3, available: 17 });

    // the order keeps no chat text
    const orderJson = JSON.stringify((await a.get(`/v1/orders/${done.body.order.id}`)).body);
    expect(orderJson).not.toContain('Rahim Uddin\\nPhone');
    expect(orderJson).not.toContain(m);

    // confirming again (same or another key) returns the same order and makes nothing
    const again = await a.post(`/v1/social-drafts/${draft.id}/confirm`, {
      ...body,
      idempotencyKey: `draft-${randomUUID()}`,
    });
    expect(again.status).toBe(200);
    expect(again.body.order.id).toBe(done.body.order.id);
    expect(await orderCount(owner)).toBe(1);
    await a.patch(`/v1/social-drafts/${draft.id}`, { note: 'late' }).expect(409);
    expect((await a.post(`/v1/social-drafts/${draft.id}/dismiss`, {})).body.code).toBe(
      'draft_closed',
    );
  });

  it('a failed confirm (not enough stock) creates nothing and leaves the draft open', async () => {
    const { owner, a, conn, variant } = await shop();
    await deliver(conn, [{ senderId: sender(), mid: mid(), text: ORDER_TEXT(variant.sku) }]);
    await runWorker();
    const id = (await a.get('/v1/social-drafts')).body.items[0].id;
    const res = await a.post(`/v1/social-drafts/${id}/confirm`, {
      customer: { name: 'Rahim Uddin', phone: '01712345678' },
      address: {
        recipientName: 'Rahim',
        phone: '01712345678',
        line1: 'House 1',
        area: 'Dhanmondi',
        district: 'Dhaka',
        division: 'Dhaka',
      },
      items: [{ variantId: variant.id, quantity: 999 }],
      confirm: true,
      idempotencyKey: `draft-${randomUUID()}`,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('insufficient_stock');
    expect(await orderCount(owner)).toBe(0);
    expect((await a.get(`/v1/social-drafts/${id}`)).body.status).toBe('needs_review');
  });

  it('replaying the same payload many times, and at once, keeps one event, one draft and one order', async () => {
    const { owner, a, conn, variant } = await shop();
    const who = sender();
    const msg = {
      senderId: who,
      mid: mid(),
      text: ORDER_TEXT(variant.sku),
      timestamp: 1_800_000_000_000,
    };
    const results = await Promise.all(Array.from({ length: 12 }, () => deliver(conn, [msg])));
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(200));
    for (let i = 0; i < 4; i++) expect((await deliver(conn, [msg])).status).toBe(200);
    expect(await events(owner)).toHaveLength(1);
    await runWorker();
    await runWorker();
    for (const e of await events(owner))
      await processSocialEvent(
        { db: t.db, log: () => undefined },
        { tenantId: owner.tenant.id, eventId: e.id },
      );
    expect(await events(owner)).toHaveLength(1);
    expect(await drafts(owner)).toHaveLength(1);

    const id = (await a.get('/v1/social-drafts')).body.items[0].id;
    const body = {
      customer: { name: 'Rahim Uddin', phone: '01712345678' },
      address: {
        recipientName: 'Rahim',
        phone: '01712345678',
        line1: 'House 1',
        area: 'Dhanmondi',
        district: 'Dhaka',
        division: 'Dhaka',
      },
      items: [{ variantId: variant.id, quantity: 2 }],
      idempotencyKey: `draft-${randomUUID()}`,
    };
    const confirms = await Promise.all(
      Array.from({ length: 6 }, () => a.post(`/v1/social-drafts/${id}/confirm`, body)),
    );
    expect(confirms.map((c) => c.status)).toEqual(Array(6).fill(200));
    expect(new Set(confirms.map((c) => c.body.order.id)).size).toBe(1);
    expect(await orderCount(owner)).toBe(1);
  });

  it('the same idempotency key on a different draft is refused, not linked twice', async () => {
    const { owner, a, conn, variant } = await shop();
    await deliver(conn, [
      { senderId: sender(), mid: mid(), text: ORDER_TEXT(variant.sku) },
      { senderId: sender(), mid: mid(), text: ORDER_TEXT(variant.sku) },
    ]);
    await runWorker();
    const [d1, d2] = (await a.get('/v1/social-drafts')).body.items as { id: string }[];
    const body = {
      customer: { name: 'Rahim Uddin', phone: '01712345678' },
      address: {
        recipientName: 'Rahim',
        phone: '01712345678',
        line1: 'House 1',
        area: 'Dhanmondi',
        district: 'Dhaka',
        division: 'Dhaka',
      },
      items: [{ variantId: variant.id, quantity: 1 }],
      idempotencyKey: `shared-${randomUUID()}`,
    };
    await a.post(`/v1/social-drafts/${d1!.id}/confirm`, body).expect(200);
    const second = await a.post(`/v1/social-drafts/${d2!.id}/confirm`, body);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('idempotency_conflict');
    expect(await orderCount(owner)).toBe(1);
  });

  it('warns about a similar recent order and about an order already made from the same chat', async () => {
    const { a, conn, variant } = await shop();
    const who = sender();
    const order = {
      customer: { name: 'Rahim Uddin', phone: '01712345678' },
      address: {
        recipientName: 'Rahim',
        phone: '01712345678',
        line1: 'House 1',
        area: 'Dhanmondi',
        district: 'Dhaka',
        division: 'Dhaka',
      },
      items: [{ variantId: variant.id, quantity: 1 }],
    };
    await a.post('/v1/orders', { ...order, idempotencyKey: `m-${randomUUID()}` }).expect(201); // a manual order, same phone and item
    await deliver(conn, [{ senderId: who, mid: mid(), text: ORDER_TEXT(variant.sku) }]);
    await runWorker();
    const first = (await a.get('/v1/social-drafts')).body.items[0].id;
    const d1 = (await a.get(`/v1/social-drafts/${first}`)).body;
    expect(d1.warnings.map((w: { code: string }) => w.code)).toContain('duplicate_order');
    expect(d1.duplicates[0].reasons.join(' ')).toMatch(/Same item|Placed/);

    await a
      .post(`/v1/social-drafts/${first}/confirm`, { ...order, idempotencyKey: `d-${randomUUID()}` })
      .expect(200);
    // the same customer writes again after the first one was confirmed: a new draft, flagged
    await deliver(conn, [{ senderId: who, mid: mid(), text: '01712345678 2 pcs ' + variant.sku }]);
    await runWorker();
    const open = (await a.get('/v1/social-drafts?status=needs_review')).body.items[0].id;
    const d2 = (await a.get(`/v1/social-drafts/${open}`)).body;
    expect(
      d2.duplicates.some((d: { reasons: string[] }) =>
        d.reasons.some((r) => /already made from this customer's chat/.test(r)),
      ),
    ).toBe(true);
  });
});

describe('what is ignored, and why nothing is stored for it', () => {
  it('acknowledges unknown Page ids and disconnected connections with 200 and stores nothing', async () => {
    const { owner, a, conn } = await shop();
    const unknown = await deliver(conn, [{ senderId: sender(), mid: mid(), text: '01712345678' }], {
      accountId: 'no-such-page',
    });
    expect(unknown.status).toBe(200);
    expect(await events(owner)).toHaveLength(0);
    await a
      .post('/v1/integrations/meta/mock/events', { connectionId: conn.id, text: 'hi' })
      .expect(200);
    await t.http
      .delete(`/v1/integrations/meta/connections/${conn.id}`)
      .set(bearer(owner.accessToken))
      .expect(200);
    const before = (await events(owner)).length;
    const gone = await deliver(conn, [{ senderId: sender(), mid: mid(), text: '01712345678' }]);
    expect(gone.status).toBe(200);
    expect(await events(owner)).toHaveLength(before);
  });

  it('records echoes, edits and postbacks as ignored without reading them, and never makes a draft from them', async () => {
    const { owner, conn } = await shop();
    const who = sender();
    const payload = {
      object: 'page',
      entry: [
        {
          id: conn.externalId,
          time: 1,
          messaging: [
            {
              sender: { id: conn.externalId },
              recipient: { id: who },
              timestamp: 1,
              message: { mid: mid(), is_echo: true, text: 'We will ship 01712345678 tomorrow' },
            },
            {
              sender: { id: who },
              recipient: { id: conn.externalId },
              timestamp: 2,
              message_edit: { mid: mid(), num_edit: 1 },
            },
            {
              sender: { id: who },
              recipient: { id: conn.externalId },
              timestamp: 3,
              postback: { title: 'Get started', payload: 'START' },
            },
            {
              sender: { id: who },
              recipient: { id: conn.externalId },
              timestamp: 4,
              delivery: { mids: ['x'] },
            },
          ],
        },
      ],
    };
    const { body, headers } = signedWebhook(payload, SECRET);
    expect((await t.http.post('/v1/webhooks/meta').set(headers).send(body)).status).toBe(200);
    const rows = await events(owner);
    expect(rows.map((r) => r.eventType).sort()).toEqual(['echo', 'edit', 'postback']);
    expect(rows.every((r) => r.status === 'ignored')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('ship');
    await runWorker();
    expect(await drafts(owner)).toHaveLength(0);
  });

  it('keeps no chit-chat: a message that does not look like an order is ignored and its text removed', async () => {
    const { owner, conn } = await shop();
    await deliver(conn, [
      { senderId: sender(), mid: mid(), text: 'hello, is this page open? thanks' },
    ]);
    await runWorker();
    const [e] = await events(owner);
    expect(e).toMatchObject({ status: 'ignored', error: 'not_order_like' });
    expect(JSON.stringify(e!.payload)).not.toContain('hello');
    expect(await drafts(owner)).toHaveLength(0);
  });

  it('records only the kind of an attachment, never a link', async () => {
    const { owner, conn } = await shop();
    const who = sender();
    const payload = sampleNotification('page', conn.externalId, [
      { senderId: who, mid: mid(), text: '01712345678', attachmentTypes: ['image'] },
    ]);
    (
      payload as { entry: { messaging: { message: { attachments: { payload: unknown }[] } }[] }[] }
    ).entry[0]!.messaging[0]!.message.attachments[0]!.payload = {
      url: 'https://cdn.fbsbx.example/secret.jpg',
    };
    const { body, headers } = signedWebhook(payload, SECRET);
    await t.http.post('/v1/webhooks/meta').set(headers).send(body).expect(200);
    const [e] = await events(owner);
    expect(e!.payload).toEqual({ text: '01712345678', attachments: [{ type: 'image' }] });
    expect(JSON.stringify(await events(owner))).not.toContain('fbsbx');
  });
});

describe('conversations', () => {
  it('appends a second message from the same customer to the same open draft, whatever order they arrive in', async () => {
    const { owner, a, conn, variant } = await shop();
    const who = sender();
    const t0 = Date.now();
    // the address was sent FIRST but arrives SECOND
    await deliver(conn, [
      { senderId: who, mid: mid(), text: `01712345678 2 pcs ${variant.sku}`, timestamp: t0 + 2000 },
    ]);
    await runWorker();
    await deliver(conn, [
      { senderId: who, mid: mid(), text: 'House 5, Road 3, Mirpur, Dhaka', timestamp: t0 + 1000 },
    ]);
    await runWorker();
    expect(await drafts(owner)).toHaveLength(1);
    const d = (await a.get(`/v1/social-drafts/${(await drafts(owner))[0]!.id}`)).body;
    expect(d.messages.map((m: { text: string }) => m.text)).toEqual([
      'House 5, Road 3, Mirpur, Dhaka',
      `01712345678 2 pcs ${variant.sku}`,
    ]); // by timestamp
    expect(d.fields.phone.value).toBe('+8801712345678');
    expect(d.fields.address.value).toBe('House 5, Road 3, Mirpur, Dhaka');
    expect(d.messageCount).toBe(2);
    expect(new Date(d.firstMessageAt).getTime()).toBe(t0 + 1000);
    // a person's edit survives a later message
    await a.patch(`/v1/social-drafts/${d.id}`, { customerName: 'Edited Name' }).expect(200);
    await deliver(conn, [
      { senderId: who, mid: mid(), text: 'Name: Someone Else', timestamp: t0 + 3000 },
    ]);
    await runWorker();
    const after = (await a.get(`/v1/social-drafts/${d.id}`)).body;
    expect(after.fields.customerName).toMatchObject({ value: 'Edited Name', edited: true });
    expect(after.messageCount).toBe(3);
  });

  it('keeps conversations of different customers apart', async () => {
    const { owner, conn, variant } = await shop();
    await deliver(conn, [
      { senderId: sender(), mid: mid(), text: `01712345678 ${variant.sku}` },
      { senderId: sender(), mid: mid(), text: `01812345678 ${variant.sku}` },
    ]);
    await runWorker();
    expect(await drafts(owner)).toHaveLength(2);
  });

  it('dismissing closes the draft; the next message from that customer starts a new one', async () => {
    const { owner, a, conn, variant } = await shop();
    const who = sender();
    await deliver(conn, [{ senderId: who, mid: mid(), text: `01712345678 ${variant.sku}` }]);
    await runWorker();
    const id = (await drafts(owner))[0]!.id;
    const dismissed = (
      await a.post(`/v1/social-drafts/${id}/dismiss`, { reason: 'spam' }).expect(200)
    ).body;
    expect(dismissed).toMatchObject({ status: 'dismissed', dismissedReason: 'spam' });
    await a.post(`/v1/social-drafts/${id}/dismiss`, {}).expect(200); // again: no-op
    await deliver(conn, [{ senderId: who, mid: mid(), text: `01712345678 ${variant.sku}` }]);
    await runWorker();
    expect(await drafts(owner)).toHaveLength(2);
    expect((await drafts(owner)).filter((d) => d.status === 'needs_review')).toHaveLength(1);
  });

  it('a follow-up message never attaches to a draft that was closed a moment before it was processed', async () => {
    const { owner, conn, variant } = await shop();
    const who = sender();
    await deliver(conn, [{ senderId: who, mid: mid(), text: `01712345678 ${variant.sku}` }]);
    await runWorker();
    const first = (await drafts(owner))[0]!;
    await deliver(conn, [{ senderId: who, mid: mid(), text: `Road 3, Dhaka ${variant.sku}` }]);
    const followUp = (await events(owner)).find((e) => e.status === 'received')!;
    // Someone closes the draft (the same lock a confirm takes) and the follow-up is processed while that is still open.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const closing = t.db.withContext({ tenantId: owner.tenant.id }, async (tx) => {
      await tx.$queryRaw`SELECT id FROM social_drafts WHERE id = ${first.id}::uuid FOR UPDATE`;
      await tx.socialDraft.update({ where: { id: first.id }, data: { status: 'dismissed' } });
      locked();
      await gate;
    });
    await held;
    const processing = processSocialEvent(
      { db: t.db, log: () => undefined },
      { tenantId: owner.tenant.id, eventId: followUp.id },
    );
    await new Promise((r) => setTimeout(r, 300));
    release();
    await closing;
    const outcome = await processing;
    expect(outcome).toMatchObject({ status: 'processed', created: true });
    const all = await drafts(owner);
    expect(all).toHaveLength(2);
    expect((all.find((d) => d.id === first.id)!.sourceEventIds as string[]).length).toBe(1);
    expect(all.find((d) => d.id !== first.id)!.status).toBe('needs_review');
  });

  it('two events of one customer processed at the same moment still make one draft', async () => {
    const { owner, conn, variant } = await shop();
    const who = sender();
    await deliver(conn, [
      {
        senderId: who,
        mid: mid(),
        text: `01712345678 ${variant.sku}`,
        timestamp: 1_800_000_000_000,
      },
      { senderId: who, mid: mid(), text: 'Road 3, Dhaka', timestamp: 1_800_000_001_000 },
    ]);
    const ids = (await events(owner)).map((e) => e.id);
    await Promise.all(
      ids.map((eventId) =>
        processSocialEvent(
          { db: t.db, log: () => undefined },
          { tenantId: owner.tenant.id, eventId },
        ),
      ),
    );
    expect(await drafts(owner)).toHaveLength(1);
    expect(((await drafts(owner))[0]!.sourceEventIds as string[]).sort()).toEqual([...ids].sort());
  });
});

describe('Redis down, and the sweeper', () => {
  it('answers 200 within the five seconds even when the queue never answers, and the sweeper queues the event later', async () => {
    const stuck = { add: () => new Promise(() => undefined) };
    const slow = await createTestApp(
      { META_MODE: 'mock', META_APP_SECRET: SECRET, META_WEBHOOK_VERIFY_TOKEN: VERIFY },
      { meta: { events: stuck } },
    );
    try {
      const owner = await registerTenant(slow);
      const conn = (
        await slow.http
          .post('/v1/integrations/meta/mock/connection')
          .set(bearer(owner.accessToken))
          .send({})
          .expect(201)
      ).body;
      const { body, headers } = signedWebhook(
        sampleNotification('page', conn.externalId, [
          { senderId: 'S1', mid: mid(), text: '01712345678' },
        ]),
        SECRET,
      );
      const started = Date.now();
      const res = await slow.http.post('/v1/webhooks/meta').set(headers).send(body);
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(4000);
      const rows = await slow.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
        tx.socialEvent.findMany({ where: { tenantId: owner.tenant.id } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('received'); // persisted: the source of truth

      // not stale yet: the sweeper leaves it
      const sweepQueue = fakeQueue();
      await sweepReceivedSocialEvents({ db: slow.db, queue: sweepQueue, log: () => undefined });
      expect(sweepQueue.jobs.has(`social-event__${rows[0]!.id}`)).toBe(false);
      await slow.db.withContext(
        { tenantId: owner.tenant.id },
        (tx) =>
          tx.$executeRaw`UPDATE social_events SET created_at = now() - interval '5 minutes' WHERE tenant_id = ${owner.tenant.id}::uuid`,
      );
      await sweepReceivedSocialEvents({ db: slow.db, queue: sweepQueue, log: () => undefined });
      expect(sweepQueue.jobs.has(`social-event__${rows[0]!.id}`)).toBe(true);
      // the sweeper is repeatable: same job id, so nothing is queued twice
      const size = sweepQueue.jobs.size;
      await sweepReceivedSocialEvents({ db: slow.db, queue: sweepQueue, log: () => undefined });
      expect(sweepQueue.jobs.size).toBe(size);
    } finally {
      await slow.close();
    }
  });

  it('a queue that throws does not fail the webhook either', async () => {
    queue.fail = true;
    try {
      const { owner, conn } = await shop();
      expect(
        (await deliver(conn, [{ senderId: sender(), mid: mid(), text: '01712345678' }])).status,
      ).toBe(200);
      expect((await events(owner))[0]!.status).toBe('received');
    } finally {
      queue.fail = false;
    }
  });
});

describe('Instagram', () => {
  it('routes object=instagram by the Instagram account id and marks the draft with its provider', async () => {
    const { a, conn, variant, owner } = await shop('instagram');
    expect(
      (
        await deliver(
          conn,
          [{ senderId: sender(), mid: mid(), text: `01712345678 ${variant.sku}` }],
          { object: 'instagram' },
        )
      ).status,
    ).toBe(200);
    // the same id is NOT a Facebook Page id
    expect(
      (
        await deliver(
          conn,
          [{ senderId: sender(), mid: mid(), text: `01812345678 ${variant.sku}` }],
          { object: 'page' },
        )
      ).status,
    ).toBe(200);
    expect(await events(owner)).toHaveLength(1);
    await runWorker();
    expect((await a.get('/v1/social-drafts')).body.items[0]).toMatchObject({
      provider: 'instagram',
    });
  });
});
