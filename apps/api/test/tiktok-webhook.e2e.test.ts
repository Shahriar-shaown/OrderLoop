import { randomUUID } from 'node:crypto';
import {
  TikTokEventJob,
  processTikTokEvent,
  sampleOrderStatusEvent,
  signedTikTokWebhook,
  sweepReceivedTikTokEvents,
  tiktokEventJobId,
  tiktokWebhookSignature,
} from '@orderloop/automation';
import { tiktokOrderSink } from '@orderloop/catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createProduct, createTestApp, registerTenant, type TestApp } from './app.js';
import { drain, fakeQueue } from './automation-helpers.js';
import { withAdmin } from './deletion-helpers.js';
import { APP_KEY, APP_SECRET, countingMetrics } from './tiktok-helpers.js';

/**
 * The real webhook route, signed with the real scheme, against a MOCK shop (so no TikTok is needed to answer): what is stored,
 * what is queued, what the answer is, and that a repeat, a forgery or a flood cannot change stock.
 */
let t: TestApp;
const queue = fakeQueue();
const { metrics } = countingMetrics();

beforeAll(async () => {
  t = await createTestApp(
    { TIKTOK_MODE: 'mock', TIKTOK_APP_KEY: APP_KEY, TIKTOK_APP_SECRET: APP_SECRET },
    { tiktok: { events: queue } },
  );
});
afterAll(() => t.close());

const URL = '/v1/webhooks/tiktok-shop';
let seq = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${++seq}`.toUpperCase();

async function shop() {
  const owner = await registerTenant(t);
  const api = (p: string, b?: object) =>
    b === undefined
      ? t.http.get(p).set(bearer(owner.accessToken))
      : t.http.post(p).set(bearer(owner.accessToken)).send(b);
  const conn = (await api('/v1/integrations/tiktok-shop/mock/connection', {})).body as {
    id: string;
    shopId: string;
  };
  const { variant } = await createProduct(t, owner.accessToken, { sku: uniq('WH') });
  await api('/v1/inventory/receive', { variantId: variant.id, quantity: 20 });
  const level = async () =>
    (
      (await api(`/v1/inventory?variantId=${variant.id}`)).body.items as {
        reserved: number;
        onHand: number;
      }[]
    )[0]!;
  /** A mock order is processed at once by the API itself, so the job its event queued has nothing left to do. */
  const settle = () => {
    for (const j of queue.pending()) if (j.data['tenantId'] === owner.tenant.id) j.done = true;
  };
  const inject = async (externalOrderId: string, quantity = 2, status = 'AWAITING_SHIPMENT') => {
    const r = (
      await api('/v1/integrations/tiktok-shop/mock/orders', {
        connectionId: conn.id,
        externalOrderId,
        status,
        updateTime: new Date(Date.now() - 3600_000).toISOString(),
        items: [{ skuId: 'sku-w', sellerSku: variant.sku, quantity }],
      })
    ).body as { orderId: string };
    settle();
    return r;
  };
  const events = (connectionId = conn.id) =>
    withAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT external_event_id, event_type, status::text AS status, error, payload FROM tiktok_events WHERE connection_id = $1 ORDER BY created_at`,
            [connectionId],
          )
        ).rows as {
          external_event_id: string;
          event_type: string;
          status: string;
          error: string | null;
          payload: object;
        }[],
    );
  const post = (payload: unknown, over: { secret?: string; key?: string } = {}) => {
    const { body, headers } = signedTikTokWebhook(
      payload,
      over.key ?? APP_KEY,
      over.secret ?? APP_SECRET,
    );
    return t.http.post(URL).set(headers).send(body);
  };
  const run = () =>
    drain(queue, (job) =>
      processTikTokEvent(
        { db: t.db, log: () => undefined, now: () => new Date(), sink: tiktokOrderSink, metrics },
        TikTokEventJob.parse(job.data),
      ),
    );
  return { owner, api, conn, variant, level, inject, events, post, run };
}

describe('a signed delivery', () => {
  it('answers 200 with an EMPTY body, stores the event, queues one job under the event id, and the worker applies it', async () => {
    const s = await shop();
    const placed = await s.inject('TT-W1');
    expect(await s.level()).toMatchObject({ reserved: 2 });
    const before = queue.adds;
    const payload = sampleOrderStatusEvent({
      shopId: s.conn.shopId,
      orderId: 'TT-W1',
      status: 'IN_TRANSIT',
      notificationId: `n-${randomUUID()}`,
    });
    const started = Date.now();
    const res = await s.post(payload);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    expect(res.headers['content-length'] ?? '0').toBe('0');
    expect(queue.adds).toBe(before + 1);
    const rows = await s.events();
    const stored = rows.find(
      (r) =>
        r.external_event_id === (payload as { tts_notification_id: string }).tts_notification_id,
    )!;
    expect(stored).toMatchObject({ event_type: 'order_status', status: 'received' });
    // ids and a status word only: nothing from `data` beyond that
    expect(Object.keys(stored.payload).sort()).toEqual([
      'onHold',
      'orderId',
      'orderStatus',
      'type',
      'updateTime',
    ]);
    const job = [...queue.jobs.values()].at(-1)!;
    expect(job.opts['jobId']).toMatch(/^tiktok-event__[0-9a-f-]{36}$/);
    expect(String(job.opts['jobId'])).not.toContain(':');
    expect(Object.keys(job.data).sort()).toEqual(['eventId', 'tenantId']);
    expect(job.opts['attempts']).toBe(5);

    const done = await s.run();
    expect(done.map((d) => d.result)).toEqual([{ status: 'processed', orderId: placed.orderId }]);
    const order = (await s.api(`/v1/tiktok-orders/${placed.orderId}`)).body;
    expect(order).toMatchObject({ status: 'IN_TRANSIT', stockState: 'shipped' });
    expect(await s.level()).toMatchObject({ onHand: 18, reserved: 0 });
  });

  it('replays of the same delivery (the retry ladder) store nothing new and move no stock', async () => {
    const s = await shop();
    await s.inject('TT-W2');
    const payload = sampleOrderStatusEvent({
      shopId: s.conn.shopId,
      orderId: 'TT-W2',
      status: 'IN_TRANSIT',
      notificationId: `n-${randomUUID()}`,
    });
    for (let i = 0; i < 5; i++) expect((await s.post(payload)).status).toBe(200);
    await s.run();
    for (let i = 0; i < 3; i++) expect((await s.post(payload)).status).toBe(200);
    await s.run();
    const rows = (await s.events()).filter((r) => r.event_type === 'order_status');
    expect(rows).toHaveLength(2); // the injected one and this one
    expect(await s.level()).toMatchObject({ onHand: 18, reserved: 0 });
  });

  it('12 concurrent identical deliveries: one event, one job, one effect; 12 workers on it: one wins', async () => {
    const s = await shop();
    const placed = await s.inject('TT-W3', 3);
    const payload = sampleOrderStatusEvent({
      shopId: s.conn.shopId,
      orderId: 'TT-W3',
      status: 'IN_TRANSIT',
      notificationId: `n-${randomUUID()}`,
    });
    const before = queue.adds;
    const sends = await Promise.all(Array.from({ length: 12 }, () => s.post(payload)));
    expect(sends.map((r) => r.status)).toEqual(Array(12).fill(200));
    expect(sends.every((r) => r.text === '')).toBe(true);
    const pending = queue.pending().filter((j) => j.data['tenantId'] === s.owner.tenant.id);
    expect(pending).toHaveLength(1);
    expect(queue.adds - before).toBeGreaterThanOrEqual(1);
    const job = pending[0]!;
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        processTikTokEvent(
          { db: t.db, log: () => undefined, now: () => new Date(), sink: tiktokOrderSink },
          TikTokEventJob.parse(job.data),
        ),
      ),
    );
    job.done = true;
    expect(results.filter((r) => r.status === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'already')).toHaveLength(11);
    expect(await s.level()).toMatchObject({ onHand: 17, reserved: 0 });
    expect((await s.api(`/v1/tiktok-orders/${placed.orderId}`)).body.stockState).toBe('shipped');
  });

  it('a delivery with no notification id is still recognised on a repeat (a deterministic key)', async () => {
    const s = await shop();
    await s.inject('TT-W4');
    const payload = sampleOrderStatusEvent({
      shopId: s.conn.shopId,
      orderId: 'TT-W4',
      status: 'IN_TRANSIT',
      timestamp: 1_790_000_500,
    });
    delete (payload as { tts_notification_id?: string }).tts_notification_id;
    await s.post(payload).expect(200);
    await s.post(payload).expect(200);
    const rows = (await s.events()).filter((r) => r.external_event_id.startsWith('derived_'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.external_event_id).toMatch(/^derived_[0-9a-f]{40}$/);
  });

  it('answers 200 empty even when Redis is down; the stored event is queued later by the sweeper', async () => {
    const s = await shop();
    const placed = await s.inject('TT-W5');
    queue.fail = true;
    const payload = sampleOrderStatusEvent({
      shopId: s.conn.shopId,
      orderId: 'TT-W5',
      status: 'IN_TRANSIT',
      notificationId: `n-${randomUUID()}`,
    });
    const started = Date.now();
    const res = await s.post(payload);
    queue.fail = false;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    const stuck = (await s.events()).find((e) => e.status === 'received')!;
    expect(stuck).toBeTruthy();
    // not old enough yet: this event is not swept (the sweeper is global, so only THIS event is looked at)
    const eventId = await withAdmin(
      async (c) =>
        (
          await c.query(`SELECT id FROM tiktok_events WHERE external_event_id = $1`, [
            payload.tts_notification_id,
          ])
        ).rows[0].id as string,
    );
    await sweepReceivedTikTokEvents({ db: t.db, queue, log: () => undefined });
    expect(queue.jobs.has(tiktokEventJobId(eventId))).toBe(false);
    await withAdmin((c) =>
      c.query(
        `UPDATE tiktok_events SET created_at = now() - interval '5 minutes' WHERE external_event_id = $1`,
        [payload.tts_notification_id],
      ),
    );
    const swept = await sweepReceivedTikTokEvents({ db: t.db, queue, log: () => undefined });
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(queue.jobs.has(tiktokEventJobId(eventId))).toBe(true);
    await s.run();
    expect((await s.api(`/v1/tiktok-orders/${placed.orderId}`)).body.status).toBe('IN_TRANSIT');
  });
});

describe('a forged or malformed delivery', () => {
  it('is refused 401 and stores and queues nothing: wrong secret, wrong key, tampered body, no header, a Bearer header', async () => {
    const s = await shop();
    await s.inject('TT-F1');
    const eventsBefore = (await s.events()).length;
    const jobsBefore = queue.adds;
    const payload = sampleOrderStatusEvent({
      shopId: s.conn.shopId,
      orderId: 'TT-F1',
      status: 'CANCELLED',
    });
    const good = signedTikTokWebhook(payload, APP_KEY, APP_SECRET);
    const attempts: [string, () => Promise<{ status: number; body: unknown }>][] = [
      ['wrong secret', () => s.post(payload, { secret: 'another-secret-another-secret' })],
      ['wrong app key', () => s.post(payload, { key: '6otherkey' })],
      [
        'tampered body',
        () => t.http.post(URL).set(good.headers).send(good.body.replace('TT-F1', 'TT-F2')),
      ],
      ['no header', () => t.http.post(URL).set('content-type', 'application/json').send(good.body)],
      [
        'a bearer header',
        () =>
          t.http
            .post(URL)
            .set({ ...good.headers, authorization: `Bearer ${good.headers.authorization}` })
            .send(good.body),
      ],
      ['an empty body', () => t.http.post(URL).set(good.headers).send('')],
      [
        'not hex',
        () =>
          t.http
            .post(URL)
            .set({ ...good.headers, authorization: 'z'.repeat(64) })
            .send(good.body),
      ],
    ];
    for (const [label, send] of attempts) {
      const res = await send();
      expect(res.status, label).toBe(401);
      expect((res.body as { code?: string }).code, label).toBe('unauthorized');
    }
    expect((await s.events()).length).toBe(eventsBefore);
    expect(queue.adds).toBe(jobsBefore);
    expect(await s.level()).toMatchObject({ reserved: 2 });
    const order = (await s.api('/v1/tiktok-orders')).body.items[0];
    expect(order.status).toBe('AWAITING_SHIPMENT');
  });

  it('signs over the exact bytes: re-spacing the JSON breaks it', async () => {
    const s = await shop();
    const payload = sampleOrderStatusEvent({
      shopId: s.conn.shopId,
      orderId: 'TT-F3',
      status: 'CANCELLED',
    });
    const compact = JSON.stringify(payload);
    const signature = tiktokWebhookSignature(compact, APP_KEY, APP_SECRET);
    const spaced = JSON.stringify(payload, null, 2);
    const res = await t.http
      .post(URL)
      .set({ 'content-type': 'application/json', authorization: signature })
      .send(spaced);
    expect(res.status).toBe(401);
    const ok = await t.http
      .post(URL)
      .set({ 'content-type': 'application/json', authorization: signature })
      .send(compact);
    expect(ok.status).toBe(200);
  });

  it('a validly signed body that is not JSON, or not a notification, is acknowledged and kept nowhere', async () => {
    const s = await shop();
    const before = (await s.events()).length;
    for (const raw of ['not json at all', '[]', '{"hello":"world"}', '{"shop_id":""}']) {
      const res = await t.http
        .post(URL)
        .set({
          'content-type': 'application/json',
          authorization: tiktokWebhookSignature(raw, APP_KEY, APP_SECRET),
        })
        .send(raw);
      expect(res.status, raw).toBe(200);
      expect(res.text).toBe('');
    }
    expect((await s.events()).length).toBe(before);
  });
});

describe('what is acknowledged but not acted on', () => {
  it('a shop that is not connected to anyone: 200, nothing stored', async () => {
    const before = await withAdmin(
      async (c) => (await c.query('SELECT count(*)::int n FROM tiktok_events')).rows[0].n as number,
    );
    const res = await t.http
      .post(URL)
      .set(
        signedTikTokWebhook(
          sampleOrderStatusEvent({ shopId: '999999999', orderId: 'X', status: 'UNPAID' }),
          APP_KEY,
          APP_SECRET,
        ).headers,
      )
      .send(
        signedTikTokWebhook(
          sampleOrderStatusEvent({ shopId: '999999999', orderId: 'X', status: 'UNPAID' }),
          APP_KEY,
          APP_SECRET,
        ).body,
      );
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    const after = await withAdmin(
      async (c) => (await c.query('SELECT count(*)::int n FROM tiktok_events')).rows[0].n as number,
    );
    expect(after).toBe(before);
  });

  it('unsupported types and package updates are recorded as ignored and never queued', async () => {
    const s = await shop();
    const jobs = queue.adds;
    const cases: [number, string, string][] = [
      [5, 'product_status', 'unsupported_event'],
      [3, 'recipient_address', 'unsupported_event'],
      [4, 'package', 'recorded_only'],
    ];
    for (const [type, label, reason] of cases) {
      const payload = sampleOrderStatusEvent({
        shopId: s.conn.shopId,
        orderId: `TT-${label}`,
        status: 'X',
        type,
        notificationId: `n-${label}-${randomUUID()}`,
      });
      (payload as { data: Record<string, unknown> }).data = {
        order_id: `TT-${label}`,
        // an address update carries the new address: it must be dropped at once
        ...(type === 3
          ? {
              recipient_address: { name: 'Siti Aminah', full_address: 'No 12 Jalan Bukit Bintang' },
            }
          : {}),
      };
      await s.post(payload).expect(200);
      const row = (await s.events()).find(
        (e) => e.external_event_id === payload.tts_notification_id,
      )!;
      expect(row, label).toMatchObject({ status: 'ignored', error: reason });
      expect(JSON.stringify(row.payload)).not.toMatch(/Siti|Bukit/);
    }
    expect(queue.adds).toBe(jobs);
  });

  it('a seller de-authorisation (type 6) marks the connection needs_reconnect', async () => {
    const s = await shop();
    const payload = sampleOrderStatusEvent({
      shopId: s.conn.shopId,
      orderId: 'n/a',
      status: 'X',
      type: 6,
      notificationId: `n-${randomUUID()}`,
    });
    (payload as { data: object }).data = {};
    await s.post(payload).expect(200);
    await s.run();
    const o = (await s.api('/v1/integrations/tiktok-shop')).body;
    expect(o.connections[0]).toMatchObject({
      status: 'needs_reconnect',
      lastErrorCode: 'deauthorized',
    });
    expect(JSON.stringify(o)).not.toMatch(/Enc"/);
  });

  it('a notification for a disconnected shop is recorded as ignored and changes nothing', async () => {
    const s = await shop();
    const placed = await s.inject('TT-DC1');
    await t.http
      .delete(`/v1/integrations/tiktok-shop/connections/${s.conn.id}`)
      .set(bearer(s.owner.accessToken))
      .expect(200);
    const payload = sampleOrderStatusEvent({
      shopId: s.conn.shopId,
      orderId: 'TT-DC1',
      status: 'CANCELLED',
      notificationId: `n-${randomUUID()}`,
    });
    const jobs = queue.adds;
    await s.post(payload).expect(200);
    const row = (await s.events()).find(
      (e) => e.external_event_id === payload.tts_notification_id,
    )!;
    expect(row).toMatchObject({ status: 'ignored', error: 'connection_disconnected' });
    expect(queue.adds).toBe(jobs);
    expect((await s.api(`/v1/tiktok-orders/${placed.orderId}`)).body.stockState).toBe('reserved');
  });

  it('a notification for an order the mock shop never had is ignored, not an error', async () => {
    const s = await shop();
    await s
      .post(
        sampleOrderStatusEvent({ shopId: s.conn.shopId, orderId: 'GHOST', status: 'IN_TRANSIT' }),
      )
      .expect(200);
    const done = await s.run();
    expect(done.map((d) => d.result)).toEqual([
      { status: 'ignored', reason: 'unknown_mock_order' },
    ]);
    const row = (await s.events()).find((e) => e.error === 'unknown_mock_order');
    expect(row?.status).toBe('ignored');
  });
});

describe('the endpoint itself', () => {
  it('does not exist (404) on a server with no TikTok app configured', async () => {
    const bare = await createTestApp({
      TIKTOK_MODE: 'mock',
      TIKTOK_APP_KEY: '',
      TIKTOK_APP_SECRET: '',
    });
    try {
      const res = await bare.http.post(URL).send('{}');
      expect(res.status).toBe(404);
    } finally {
      await bare.close();
    }
  });

  it('is public (needs no session) and is not limited to a handful of requests', async () => {
    const s = await shop();
    const results: number[] = [];
    for (let i = 0; i < 30; i++)
      results.push(
        (
          await s.post(
            sampleOrderStatusEvent({ shopId: s.conn.shopId, orderId: `RL-${i}`, status: 'UNPAID' }),
          )
        ).status,
      );
    expect(new Set(results)).toEqual(new Set([200]));
  });
});
