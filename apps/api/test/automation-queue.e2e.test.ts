import {
  AUTOMATION_JOB_OPTIONS,
  QUEUES,
  TICK_EVERY_MS,
  TICK_SCHEDULER_ID,
  handleDeliverJob,
  handleEvaluateJob,
  jobIdOf,
  runAutomationTick,
} from '@orderloop/automation';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createTestApp, registerTenant, type TestApp } from './app.js';
import {
  deliveryHarness,
  lowStockItem,
  placeOrder,
  runtimeOf,
  wait,
} from './automation-helpers.js';

/**
 * The same wiring as apps/worker, against the real Redis (test index): real BullMQ queues and workers, real job ids and
 * options, the real scheduler registration. The default queues of the API are used (nothing is faked).
 */
let t: TestApp;
let connection: Redis;
const queues: Queue[] = [];
const workers: Worker[] = [];
const harness = () => deliveryHarness(t);
let h: ReturnType<typeof deliveryHarness>;

const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(100);
  }
};

beforeAll(async () => {
  t = await createTestApp();
  connection = new Redis(process.env['REDIS_URL']!, { maxRetriesPerRequest: null });
  h = harness();
  const evaluateDeps = runtimeOf(t).deps;
  const evaluate = new Worker(
    QUEUES.evaluate,
    (job) =>
      handleEvaluateJob(evaluateDeps, job.data, {
        jobId: job.id,
        attempt: job.attemptsStarted,
        maxAttempts: job.opts.attempts,
      }),
    { connection, concurrency: 2 },
  );
  const deliver = new Worker(
    QUEUES.deliver,
    (job) =>
      handleDeliverJob(h.deps, job.data, {
        jobId: job.id,
        attempt: job.attemptsStarted,
        maxAttempts: job.opts.attempts,
      }),
    { connection, concurrency: 2 },
  );
  workers.push(evaluate, deliver);
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(queues.map((q) => q.close()));
  connection.disconnect();
  await t.close();
});

describe('real BullMQ: scheduler, deterministic ids, retries and the new-order event', () => {
  it('registers one scheduler by id, however many times (several workers) it is registered', async () => {
    const tick = new Queue(QUEUES.tick, { connection });
    queues.push(tick);
    for (let i = 0; i < 3; i++)
      await tick.upsertJobScheduler(
        TICK_SCHEDULER_ID,
        { every: TICK_EVERY_MS },
        { name: 'tick', data: {}, opts: { removeOnComplete: { age: 3600 } } },
      );
    const schedulers = await tick.getJobSchedulers();
    expect(schedulers.filter((s) => s.key === TICK_SCHEDULER_ID)).toHaveLength(1);
    expect(schedulers[0]!.every).toBe(60_000);
    await tick.removeJobScheduler(TICK_SCHEDULER_ID);
  });

  it('a tick queues a due scan under a deterministic id; a second tick adds none; the run and its deliveries complete once', async () => {
    const owner = await registerTenant(t);
    const staff = await addMember(t, owner, 'STAFF');
    await t.http
      .post('/v1/push-devices')
      .set(bearer(owner.accessToken))
      .send({ token: `ExponentPushToken[queue-${owner.tenant.id.slice(0, 10)}]`, platform: 'ios' })
      .expect(200);
    await t.http
      .put('/v1/automation/rules/LOW_STOCK')
      .set(bearer(owner.accessToken))
      .send({ enabled: true })
      .expect(200);
    await lowStockItem(t, owner.accessToken, { stock: 1, reorderPoint: 5 });
    const evaluate = new Queue(QUEUES.evaluate, { connection });
    const deliver = new Queue(QUEUES.deliver, { connection });
    queues.push(evaluate, deliver);
    const deps = {
      db: t.db,
      queues: { evaluate, deliver },
      now: () => new Date(),
      log: () => undefined,
    };
    await runAutomationTick(deps);
    await runAutomationTick(deps);
    const rule = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.automationRule.findFirstOrThrow({ where: { tenantId: owner.tenant.id } }),
    );
    const run = await waitFor(async () => {
      const r = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
        tx.automationRun.findFirst({ where: { tenantId: owner.tenant.id } }),
      );
      return r?.status === 'succeeded' ? r : undefined;
    });
    expect(run).toMatchObject({ trigger: 'scheduled', createdCount: 2, attempts: 1 });
    expect(run.slotKey).toMatch(/^scan:\d{8}T\d{4}Z$/);
    // the job had the deterministic id and the retry policy
    const job = await evaluate.getJob(jobIdOf(rule.id, run.slotKey));
    expect(job?.id).toBe(`${rule.id}__${run.slotKey.replaceAll(':', '_')}`);
    expect(job?.opts.attempts).toBe(AUTOMATION_JOB_OPTIONS.attempts);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 10_000 });
    expect(job?.opts.removeOnComplete).toEqual({ age: 86_400 });
    expect(job?.opts.removeOnFail).toEqual({ age: 7 * 86_400 });
    // the deliveries ran: owner's push sent, staff's push skipped (no device), no duplicates
    await waitFor(async () => {
      const ds = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
        tx.notificationDelivery.findMany({ where: { tenantId: owner.tenant.id, channel: 'push' } }),
      );
      return ds.length === 2 && ds.every((d) => d.status !== 'pending') ? ds : undefined;
    });
    expect(h.sent.push.filter((p) => p.data.kind === 'LOW_STOCK').length).toBeGreaterThanOrEqual(1);
    const sentToOwner = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.notificationDelivery.findMany({
        where: { tenantId: owner.tenant.id, channel: 'push', status: 'sent' },
      }),
    );
    expect(sentToOwner).toHaveLength(1);
    // and the same slot, queued again after the fact, does nothing new
    await runAutomationTick(deps);
    await wait(500);
    expect(
      await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
        tx.notification.count({ where: { tenantId: owner.tenant.id } }),
      ),
    ).toBe(2);
    void staff;
  });

  it('an order created through the API reaches the worker as one event job and is announced once', async () => {
    const owner = await registerTenant(t);
    const item = await lowStockItem(t, owner.accessToken, { stock: 10, reorderPoint: 0 });
    await t.http
      .put('/v1/automation/rules/NEW_ORDER')
      .set(bearer(owner.accessToken))
      .send({ enabled: true })
      .expect(200);
    await wait(30);
    const order = await placeOrder(t, owner.accessToken, item.variantId);
    const evaluate = new Queue(QUEUES.evaluate, { connection });
    queues.push(evaluate);
    const note = await waitFor(async () => {
      const r = await t.http.get('/v1/notifications').set(bearer(owner.accessToken));
      return r.body.items?.[0];
    });
    expect(note.title).toBe(`New order #${order.orderNumber}`);
    const job = await evaluate.getJob(`neworder__${order.id}`);
    expect(job?.data).toEqual({ type: 'neworder', tenantId: owner.tenant.id, orderId: order.id });
    await wait(300);
    expect(
      (await t.http.get('/v1/notifications').set(bearer(owner.accessToken))).body.items,
    ).toHaveLength(1);
  });
});
