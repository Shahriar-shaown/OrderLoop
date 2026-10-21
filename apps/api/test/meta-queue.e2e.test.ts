import { randomUUID } from 'node:crypto';
import {
  META_QUEUES,
  SocialEventJob,
  processSocialEvent,
  sampleNotification,
  signedWebhook,
  socialEventJobId,
} from '@orderloop/automation';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, registerTenant, type TestApp } from './app.js';

/**
 * The same wiring as apps/worker, against the real Redis (test index): the API's real queue, a real BullMQ worker running the
 * real processor, the real job id. Nothing is faked.
 */
const SECRET = 'test-app-secret-0123456789';
let t: TestApp;
let connection: Redis;
let worker: Worker;
let attempts = 0;

const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
};

beforeAll(async () => {
  t = await createTestApp({
    META_MODE: 'mock',
    META_APP_SECRET: SECRET,
    META_WEBHOOK_VERIFY_TOKEN: 'v'.repeat(20),
  });
  connection = new Redis(process.env['REDIS_URL']!, { maxRetriesPerRequest: null });
  worker = new Worker(
    META_QUEUES.events,
    async (job) => {
      attempts += 1;
      await processSocialEvent({ db: t.db, log: () => undefined }, SocialEventJob.parse(job.data));
    },
    { connection, concurrency: 2 },
  );
});
afterAll(async () => {
  await worker.close();
  connection.disconnect();
  await t.close();
});

describe('real BullMQ: a signed webhook reaches the worker as one job per event', () => {
  it('stores, queues under the event id, processes once, and Meta’s retries add nothing', async () => {
    const owner = await registerTenant(t);
    const conn = (
      await t.http
        .post('/v1/integrations/meta/mock/connection')
        .set(bearer(owner.accessToken))
        .send({})
        .expect(201)
    ).body;
    const mid = `m_${randomUUID()}`;
    const { body, headers } = signedWebhook(
      sampleNotification('page', conn.externalId, [
        { senderId: 'PSID-q', mid, text: 'অর্ডার, ০১৭১২৩৪৫৬৭৮' },
      ]),
      SECRET,
    );
    const before = attempts;
    const sends = await Promise.all(
      Array.from({ length: 5 }, () => t.http.post('/v1/webhooks/meta').set(headers).send(body)),
    );
    expect(sends.map((s) => s.status)).toEqual([200, 200, 200, 200, 200]);

    const draft = await waitFor(async () => {
      const rows = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
        tx.socialDraft.findMany({ where: { tenantId: owner.tenant.id } }),
      );
      return rows[0];
    });
    expect(draft.mock).toBe(true);
    const events = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.socialEvent.findMany({ where: { tenantId: owner.tenant.id } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe('processed');
    // one job, under the deterministic id
    const { Queue } = await import('bullmq');
    const q = new Queue(META_QUEUES.events, { connection });
    try {
      expect(await q.getJob(socialEventJobId(events[0]!.id))).toBeTruthy();
    } finally {
      await q.close();
    }
    expect(attempts - before).toBe(1);
  });
});
