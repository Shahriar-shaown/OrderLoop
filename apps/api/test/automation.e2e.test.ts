import {
  claimRun,
  executeRule,
  handleEvaluateJob,
  processDelivery,
  runAutomationTick,
  type RunTarget,
} from '@orderloop/automation';
import type { AutomationKind } from '@orderloop/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createTestApp, registerTenant, type TestApp } from './app.js';
import {
  deliveryHarness,
  drain,
  fakeQueue,
  lowStockItem,
  placeOrder,
  runtimeOf,
  wait,
  type FakeQueue,
} from './automation-helpers.js';

let t: TestApp;
let evaluate: FakeQueue;
let deliver: FakeQueue;
let clock = () => new Date();
beforeAll(async () => {
  evaluate = fakeQueue();
  deliver = fakeQueue();
  t = await createTestApp({}, { automation: { evaluate, deliver, now: () => clock() } });
});
afterAll(() => t.close());

type Session = Awaited<ReturnType<typeof registerTenant>>;

/** A business with one member of every role. */
async function business() {
  const owner = await registerTenant(t);
  const admin = await addMember(t, owner, 'ADMIN');
  const manager = await addMember(t, owner, 'MANAGER');
  const staff = await addMember(t, owner, 'STAFF');
  const accountant = await addMember(t, owner, 'ACCOUNTANT');
  return { owner, admin, manager, staff, accountant, tenantId: owner.tenant.id };
}
type Biz = Awaited<ReturnType<typeof business>>;

const as = (who: { accessToken: string }) => ({
  get: (path: string) => t.http.get(path).set(bearer(who.accessToken)),
  put: (path: string, body: object = {}) =>
    t.http.put(path).set(bearer(who.accessToken)).send(body),
  patch: (path: string, body: object = {}) =>
    t.http.patch(path).set(bearer(who.accessToken)).send(body),
  post: (path: string, body: object = {}) =>
    t.http.post(path).set(bearer(who.accessToken)).send(body),
  del: (path: string) => t.http.delete(path).set(bearer(who.accessToken)),
});

const rule = (who: Session, kind: AutomationKind, body: object) =>
  as(who).put(`/v1/automation/rules/${kind}`, body);
const run = (who: Session, kind: AutomationKind, body: object = {}) =>
  as(who).post(`/v1/automation/rules/${kind}/run`, body);
const notes = async (who: Session, query = '') =>
  (await as(who).get(`/v1/notifications${query}`).expect(200)).body as {
    items: {
      id: string;
      kind: string;
      title: string;
      body: string;
      data: Record<string, unknown>;
      readAt: string | null;
    }[];
    nextCursor: string | null;
  };
const countNotes = async (who: Session, kind?: string) =>
  (await notes(who, '?limit=100')).items.filter((n) => !kind || n.kind === kind).length;

const ctxOf = (tenantId: string) => ({ tenantId });
const ruleIdOf = async (who: Session, kind: AutomationKind) =>
  (
    await t.db.withContext(ctxOf(who.tenant.id), (tx) =>
      tx.automationRule.findFirstOrThrow({ where: { tenantId: who.tenant.id, kind } }),
    )
  ).id;

const deliveriesOf = (tenantId: string) =>
  t.db.withContext(ctxOf(tenantId), (tx) =>
    tx.notificationDelivery.findMany({
      where: { tenantId },
      include: { notification: { select: { userId: true, kind: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  );

describe('rules: defaults, validation and who may change them', () => {
  it('lists all seven kinds with defaults, disabled and not configured, until someone saves them', async () => {
    const b = await business();
    const res = await as(b.owner).get('/v1/automation/rules').expect(200);
    expect(res.body.rules.map((r: { kind: string }) => r.kind)).toEqual([
      'LOW_STOCK',
      'NEW_ORDER',
      'UNCONFIRMED_ORDER',
      'DELAYED_ORDER',
      'COD_DISCREPANCY',
      'DAILY_REPORT',
      'WEEKLY_REPORT',
    ]);
    for (const r of res.body.rules) {
      expect(r).toMatchObject({
        configured: false,
        enabled: false,
        lastRun: null,
        updatedAt: null,
      });
      expect(r.channels).toEqual({
        inApp: true,
        push: true,
        email: false,
        sms: false,
        whatsapp: false,
      });
    }
    expect(
      res.body.rules.find((r: { kind: string }) => r.kind === 'UNCONFIRMED_ORDER').config,
    ).toEqual({ afterMinutes: 60 });
    expect(
      res.body.rules.find((r: { kind: string }) => r.kind === 'LOW_STOCK').recipientPermission,
    ).toBe('inventory:read');
    expect(
      res.body.rules.find((r: { kind: string }) => r.kind === 'DAILY_REPORT').recipientPermission,
    ).toBe('finance:read');
    expect(res.body.providers).toEqual({ push: 'dev', sms: false, whatsapp: false, email: true });
  });

  it('validates each kind: bad numbers, times and weekdays are 400 with the path of the field', async () => {
    const b = await business();
    const bad = async (kind: AutomationKind, config: object, path: string) => {
      const res = await rule(b.owner, kind, { enabled: true, config }).expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors.map((e: { path: string }) => e.path)).toContain(path);
    };
    await bad('UNCONFIRMED_ORDER', { afterMinutes: 2 }, 'body.config.afterMinutes');
    await bad(
      'UNCONFIRMED_ORDER',
      { afterMinutes: 60, repeatEveryMinutes: 99999 },
      'body.config.repeatEveryMinutes',
    );
    await bad('DELAYED_ORDER', { afterHours: 0 }, 'body.config.afterHours');
    await bad('LOW_STOCK', { basis: 'fixed', includeZeroStock: true }, 'body.config.fixedQuantity');
    await bad('DAILY_REPORT', { localTime: '25:00' }, 'body.config.localTime');
    await bad('WEEKLY_REPORT', { localTime: '09:00', weekday: 9 }, 'body.config.weekday');
    await bad('COD_DISCREPANCY', { minAmountMinor: -5 }, 'body.config.minAmountMinor');
    await as(b.owner).put('/v1/automation/rules/NOT_A_KIND', { enabled: true }).expect(400);
    // nothing was saved by any of those
    expect(
      (await as(b.owner).get('/v1/automation/rules')).body.rules.every(
        (r: { configured: boolean }) => !r.configured,
      ),
    ).toBe(true);
  });

  it('saves a rule, returns it, and records which fields changed (and nothing when a repeat changes nothing)', async () => {
    const b = await business();
    const body = {
      enabled: true,
      config: { afterMinutes: 30, repeatEveryMinutes: 15 },
      channels: { email: true },
    };
    const first = await rule(b.owner, 'UNCONFIRMED_ORDER', body).expect(200);
    expect(first.body).toMatchObject({
      kind: 'UNCONFIRMED_ORDER',
      configured: true,
      enabled: true,
      config: { afterMinutes: 30, repeatEveryMinutes: 15 },
      channels: { inApp: true, push: true, email: true, sms: false, whatsapp: false },
    });
    await rule(b.owner, 'UNCONFIRMED_ORDER', body).expect(200); // the same again
    await rule(b.owner, 'UNCONFIRMED_ORDER', { enabled: false }).expect(200);
    const audit = await t.db.withContext(ctxOf(b.tenantId), (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: b.tenantId, action: 'automation.rule_changed' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audit.map((a) => a.metadata)).toEqual([
      { kind: 'UNCONFIRMED_ORDER', fields: ['enabled', 'config', 'channels'] },
      { kind: 'UNCONFIRMED_ORDER', fields: ['enabled'] },
    ]);
    // only field names: the values are not in the audit trail
    expect(JSON.stringify(audit.map((a) => a.metadata))).not.toContain('30');
  });

  it('automation:read is OWNER, ADMIN and MANAGER; automation:manage is OWNER and ADMIN', async () => {
    const b = await business();
    const status = async (
      who: Session,
      method: 'get' | 'put' | 'post',
      path: string,
      body: object = {},
    ) =>
      (
        await (method === 'get'
          ? as(who).get(path)
          : method === 'put'
            ? as(who).put(path, body)
            : as(who).post(path, body))
      ).status;
    const kinds = ['owner', 'admin', 'manager', 'staff', 'accountant'] as const;
    const read = { owner: 200, admin: 200, manager: 200, staff: 403, accountant: 403 };
    const manage = { owner: 200, admin: 200, manager: 403, staff: 403, accountant: 403 };
    const fakeId = '0197b0a0-0000-7000-8000-000000000001';
    for (const k of kinds) {
      expect(await status(b[k], 'get', '/v1/automation/rules'), `${k} rules`).toBe(read[k]);
      expect(await status(b[k], 'get', '/v1/automation/runs'), `${k} runs`).toBe(read[k]);
      expect(await status(b[k], 'get', '/v1/automation/deliveries'), `${k} deliveries`).toBe(
        read[k],
      );
      expect(
        await status(b[k], 'put', '/v1/automation/rules/NEW_ORDER', { enabled: true }),
        `${k} put`,
      ).toBe(manage[k]);
      if (manage[k] === 403) {
        expect(await status(b[k], 'post', '/v1/automation/rules/NEW_ORDER/run'), `${k} run`).toBe(
          403,
        );
        expect(
          await status(b[k], 'post', `/v1/automation/runs/${fakeId}/retry`),
          `${k} retry run`,
        ).toBe(403);
        expect(
          await status(b[k], 'post', `/v1/automation/deliveries/${fakeId}/retry`),
          `${k} retry delivery`,
        ).toBe(403);
      }
    }
  });

  it('notifications, preferences, devices and consents are self-service for every role', async () => {
    const b = await business();
    for (const k of ['owner', 'admin', 'manager', 'staff', 'accountant'] as const) {
      const api = as(b[k]);
      await api.get('/v1/notifications').expect(200);
      await api.get('/v1/notifications/unread-count').expect(200);
      await api.post('/v1/notifications/read-all').expect(200);
      await api.get('/v1/notification-preferences').expect(200);
      await api.get('/v1/messaging-consents').expect(200);
      await api
        .post('/v1/push-devices', {
          token: `ExponentPushToken[${k}-device-token]`,
          platform: 'ios',
        })
        .expect(200);
      await api
        .del(`/v1/push-devices/${encodeURIComponent(`ExponentPushToken[${k}-device-token]`)}`)
        .expect(200);
    }
    await t.http.get('/v1/notifications').expect(401);
  });
});

describe('LOW_STOCK: who is told, once, and again after a recovery', () => {
  it('tells the right members once, however often it runs or how many run at once', async () => {
    const b = await business();
    // the manager does not want these; the owner wants email too
    await as(b.manager)
      .put('/v1/notification-preferences', {
        items: [{ kind: 'LOW_STOCK', inApp: false, push: false, email: false }],
      })
      .expect(200);
    await as(b.owner)
      .put('/v1/notification-preferences', { items: [{ kind: 'LOW_STOCK', email: true }] })
      .expect(200);
    const item = await lowStockItem(t, b.owner.accessToken, {
      stock: 2,
      reorderPoint: 5,
      name: 'Cotton panjabi',
    });
    await rule(b.owner, 'LOW_STOCK', { enabled: true, channels: { email: true } }).expect(200);

    const first = await run(b.owner, 'LOW_STOCK').expect(200);
    expect(first.body).toMatchObject({
      kind: 'LOW_STOCK',
      status: 'succeeded',
      trigger: 'manual',
      createdCount: 4,
    }); // owner, admin, staff, accountant
    for (const k of ['owner', 'admin', 'staff', 'accountant'] as const)
      expect(await countNotes(b[k], 'LOW_STOCK'), k).toBe(1);
    expect(await countNotes(b.manager)).toBe(0);
    const n = (await notes(b.owner)).items[0]!;
    expect(n.title).toBe('Low stock: 1 item');
    expect(n.body).toContain(item.sku);
    expect(n.body).toContain('Cotton panjabi');
    expect(n.data).toMatchObject({ kind: 'LOW_STOCK', count: 1, variantIds: [item.variantId] });

    // deliveries: one per (notification, channel), and only the channels each person allows
    const channelsOf = async (userId: string) =>
      (await deliveriesOf(b.tenantId))
        .filter((d) => d.notification.userId === userId)
        .map((d) => d.channel)
        .sort();
    expect(await channelsOf(b.owner.user.id)).toEqual(['email', 'in_app', 'push']);
    expect(await channelsOf(b.staff.user.id)).toEqual(['in_app', 'push']);
    expect(await channelsOf(b.manager.user.id)).toEqual([]);
    const queued = deliver
      .list('deliver')
      .filter((j) => (j.data as { tenantId: string }).tenantId === b.tenantId);
    expect(queued).toHaveLength(4 /* push */ + 1 /* owner email */);

    // again, and two at once: still exactly one each
    const again = await run(b.owner, 'LOW_STOCK').expect(200);
    expect(again.body).toMatchObject({ status: 'succeeded', createdCount: 0 });
    const [x, y] = await Promise.all([run(b.owner, 'LOW_STOCK'), run(b.admin, 'LOW_STOCK')]);
    expect([x.status, y.status]).toEqual([200, 200]);
    for (const k of ['owner', 'admin', 'staff', 'accountant'] as const)
      expect(await countNotes(b[k], 'LOW_STOCK'), k).toBe(1);
    expect(await deliveriesOf(b.tenantId)).toHaveLength(4 * 2 + 1);
  });

  it('two triggers racing over a NEW low item create one notification and one delivery per channel', async () => {
    const b = await business();
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    const results = await Promise.all(Array.from({ length: 4 }, () => run(b.owner, 'LOW_STOCK')));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.map((r) => r.body.createdCount).sort()).toEqual([0, 0, 0, 5]); // exactly one run announced it
    for (const k of ['owner', 'admin', 'manager', 'staff', 'accountant'] as const)
      expect(await countNotes(b[k]), k).toBe(1);
    const ds = await deliveriesOf(b.tenantId);
    expect(ds.filter((d) => d.channel === 'push')).toHaveLength(5);
    expect(ds.filter((d) => d.channel === 'in_app')).toHaveLength(5);
  });

  it('stays quiet until stock recovers, then announces the next dip again', async () => {
    const b = await business();
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    const item = await lowStockItem(t, b.owner.accessToken, { stock: 2, reorderPoint: 5 });
    await run(b.owner, 'LOW_STOCK').expect(200);
    expect(await countNotes(b.owner)).toBe(1);
    await run(b.owner, 'LOW_STOCK').expect(200);
    expect(await countNotes(b.owner)).toBe(1);
    // recover above the threshold: nothing new, and the episode ends
    await as(b.owner)
      .post('/v1/inventory/receive', { variantId: item.variantId, quantity: 20 })
      .expect(201);
    expect((await run(b.owner, 'LOW_STOCK')).body).toMatchObject({
      status: 'succeeded',
      createdCount: 0,
    });
    expect(
      await t.db.withContext(ctxOf(b.tenantId), (tx) =>
        tx.automationState.count({ where: { tenantId: b.tenantId } }),
      ),
    ).toBe(0);
    // dip again: one new notification
    await as(b.owner)
      .post('/v1/inventory/adjust', {
        variantId: item.variantId,
        delta: -19,
        reason: 'stock count correction',
      })
      .expect(201);
    expect((await run(b.owner, 'LOW_STOCK')).body).toMatchObject({ createdCount: 5 });
    expect(await countNotes(b.owner)).toBe(2);
    await run(b.owner, 'LOW_STOCK').expect(200);
    expect(await countNotes(b.owner)).toBe(2);
  });

  it('honours the basis and the zero-stock switch', async () => {
    const b = await business();
    const empty = await lowStockItem(t, b.owner.accessToken, {
      stock: 0,
      reorderPoint: 5,
      name: 'Empty one',
    });
    const low = await lowStockItem(t, b.owner.accessToken, {
      stock: 3,
      reorderPoint: 5,
      name: 'Low one',
    });
    const fine = await lowStockItem(t, b.owner.accessToken, {
      stock: 50,
      reorderPoint: 5,
      name: 'Fine one',
    });
    const noThreshold = await lowStockItem(t, b.owner.accessToken, {
      stock: 1,
      reorderPoint: 0,
      name: 'Untracked',
    });
    // reorder point basis, no zero stock: only the running-low one
    await rule(b.owner, 'LOW_STOCK', {
      enabled: true,
      config: { basis: 'reorder_point', includeZeroStock: false },
    }).expect(200);
    await run(b.owner, 'LOW_STOCK').expect(200);
    let n = (await notes(b.owner)).items;
    expect(n).toHaveLength(1);
    expect(n[0]!.data.variantIds).toEqual([low.variantId]);
    // with zero stock included the empty one is announced too (the untracked one never is)
    await rule(b.owner, 'LOW_STOCK', {
      config: { basis: 'reorder_point', includeZeroStock: true },
    }).expect(200);
    await run(b.owner, 'LOW_STOCK').expect(200);
    n = (await notes(b.owner)).items;
    expect(n).toHaveLength(2);
    expect(n[0]!.data.variantIds).toEqual([empty.variantId]);
    // a fixed threshold of 60 covers every tracked variant, including the one with a reorder point of 0
    await rule(b.owner, 'LOW_STOCK', {
      config: { basis: 'fixed', fixedQuantity: 60, includeZeroStock: true },
    }).expect(200);
    await run(b.owner, 'LOW_STOCK').expect(200);
    n = (await notes(b.owner)).items;
    const latest = n[0]!;
    expect(latest.data.count).toBe(2); // the fine one and the untracked one are newly low under the new basis
    expect((latest.data.variantIds as string[]).sort()).toEqual(
      [fine.variantId, noThreshold.variantId].sort(),
    );
  });

  it('a digest names at most five items and counts the rest', async () => {
    const b = await business();
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    for (let i = 0; i < 8; i++)
      await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    await run(b.owner, 'LOW_STOCK').expect(200);
    const n = (await notes(b.owner)).items;
    expect(n).toHaveLength(1);
    expect(n[0]!.title).toBe('Low stock: 8 items');
    expect(n[0]!.data.variantIds).toHaveLength(5);
    expect(n[0]!.body).toContain('and 3 more');
  });

  it('a disabled rule creates nothing, by hand or by the scheduler', async () => {
    const b = await business();
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    // never saved
    await run(b.owner, 'LOW_STOCK').expect(409);
    await rule(b.owner, 'LOW_STOCK', { enabled: false }).expect(200);
    await run(b.owner, 'LOW_STOCK').expect(409);
    // a scan job that was queued before it was switched off does nothing
    const ruleId = await ruleIdOf(b.owner, 'LOW_STOCK');
    const out = await handleEvaluateJob(runtimeOf(t).deps, {
      type: 'scan',
      tenantId: b.tenantId,
      ruleId,
      kind: 'LOW_STOCK',
      slotKey: 'scan:20990101T0000Z',
      scheduledFor: '2099-01-01T00:00:00.000Z',
    });
    expect(out).toEqual({ outcome: 'disabled', run: null });
    expect(await countNotes(b.owner)).toBe(0);
    expect((await as(b.owner).get('/v1/automation/runs')).body.items).toEqual([]);
    // and the tick does not even see it
    const q = fakeQueue();
    await runAutomationTick({
      db: t.db,
      queues: { evaluate: q, deliver: fakeQueue() },
      now: () => new Date(),
      log: () => undefined,
    });
    expect(
      q.list().filter((j) => (j.data as { tenantId: string }).tenantId === b.tenantId),
    ).toHaveLength(0);
  });

  it('nobody to tell: the run is skipped and nothing is claimed, so a later recipient still hears of it', async () => {
    const b = await business();
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    // everyone switches this kind off
    for (const k of ['owner', 'admin', 'manager', 'staff', 'accountant'] as const)
      await as(b[k])
        .put('/v1/notification-preferences', {
          items: [{ kind: 'LOW_STOCK', inApp: false, push: false, email: false }],
        })
        .expect(200);
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    expect((await run(b.owner, 'LOW_STOCK')).body).toMatchObject({
      status: 'skipped',
      createdCount: 0,
      skippedCount: 5,
    });
    expect(
      await t.db.withContext(ctxOf(b.tenantId), (tx) =>
        tx.automationState.count({ where: { tenantId: b.tenantId } }),
      ),
    ).toBe(0);
    await as(b.staff)
      .put('/v1/notification-preferences', { items: [{ kind: 'LOW_STOCK', inApp: true }] })
      .expect(200);
    expect((await run(b.owner, 'LOW_STOCK')).body).toMatchObject({
      status: 'succeeded',
      createdCount: 1,
    });
    expect(await countNotes(b.staff)).toBe(1);
  });

  it('the run is rate limited per business', async () => {
    const b = await business();
    await rule(b.owner, 'NEW_ORDER', { enabled: true }).expect(200);
    for (let i = 0; i < 10; i++) await run(b.owner, 'NEW_ORDER').expect(200);
    const res = await run(b.owner, 'NEW_ORDER').expect(429);
    expect(res.body.code).toBe('rate_limited');
    // another business is not affected
    const other = await business();
    await rule(other.owner, 'NEW_ORDER', { enabled: true }).expect(200);
    await run(other.owner, 'NEW_ORDER').expect(200);
  });

  it('the same idempotency key returns the first run instead of starting another', async () => {
    const b = await business();
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    const a = await run(b.owner, 'LOW_STOCK', { idempotencyKey: 'click-12345678' }).expect(200);
    const c = await run(b.owner, 'LOW_STOCK', { idempotencyKey: 'click-12345678' }).expect(200);
    expect(c.body.id).toBe(a.body.id);
    expect((await as(b.owner).get('/v1/automation/runs')).body.items).toHaveLength(1);
  });
});

describe('delivery: claims, retries and permanent failures', () => {
  /** A business with a low-stock rule that sends push and email to the owner, ready to deliver. */
  async function ready() {
    const b = await business();
    await as(b.owner)
      .put('/v1/notification-preferences', { items: [{ kind: 'LOW_STOCK', email: true }] })
      .expect(200);
    await as(b.owner)
      .post('/v1/push-devices', {
        token: `ExponentPushToken[${b.tenantId.slice(0, 18)}]`,
        platform: 'android',
      })
      .expect(200);
    await rule(b.owner, 'LOW_STOCK', { enabled: true, channels: { email: true } }).expect(200);
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    await run(b.owner, 'LOW_STOCK').expect(200);
    const jobs = deliver
      .list('deliver')
      .filter((j) => (j.data as { tenantId: string }).tenantId === b.tenantId);
    const ofChannel = async (channel: string, userId = b.owner.user.id) =>
      (await deliveriesOf(b.tenantId)).find(
        (d) => d.channel === channel && d.notification.userId === userId,
      )!;
    return {
      b,
      jobs,
      ofChannel,
      jobFor: (id: string) => jobs.find((j) => j.data.deliveryId === id)!,
    };
  }

  it('sends push and email once, with the private wording, and never again', async () => {
    const { b, jobs, ofChannel } = await ready();
    const h = deliveryHarness(t);
    for (const job of jobs) {
      job.attemptsStarted += 1;
      await h.process(job);
    }
    expect(h.sent.email).toHaveLength(1);
    expect(h.sent.email[0]).toMatchObject({ to: b.owner.email, subject: 'Low stock: 1 item' });
    expect(h.sent.email[0]!.messageId).toContain((await ofChannel('email')).id);
    // push to the owner's one device (the other members have none: skipped)
    expect(h.sent.push).toHaveLength(1);
    expect(h.sent.push[0]).toMatchObject({
      title: 'Low stock alert',
      body: 'Open OrderLoop to see the details.',
      platform: 'android',
    });
    expect(Object.keys(h.sent.push[0]!.data).sort()).toEqual(['id', 'kind']);
    const states = (await deliveriesOf(b.tenantId)).map((d) => `${d.channel}:${d.status}`);
    expect(states.filter((s) => s === 'push:sent')).toHaveLength(1);
    expect(states.filter((s) => s === 'push:skipped')).toHaveLength(4);
    expect(states).toContain('email:sent');
    // the same jobs again (a duplicate delivery of the queue message): nothing is sent twice
    for (const job of jobs) expect((await h.process(job)).outcome).toBe('noop');
    expect(h.sent.email).toHaveLength(1);
    expect(h.sent.push).toHaveLength(1);
    // in the mailbox too
    expect(t.mail.to(b.owner.email, 'notification')).toHaveLength(1);
  });

  it('a failure then a retry records exactly one send and counts the attempts', async () => {
    const { jobs, ofChannel, jobFor } = await ready();
    const h = deliveryHarness(t);
    h.control.emailError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    h.control.emailErrorTimes = 1;
    const email = await ofChannel('email');
    const job = jobFor(email.id);
    job.attemptsStarted = 1;
    await expect(h.process(job)).rejects.toThrow('connection reset'); // transient: thrown so the queue retries
    let row = await ofChannel('email');
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row.lastError).toMatch(/^transient:/);
    // the queue redelivers (attempt 2)
    job.attemptsStarted = 2;
    expect(await h.process(job)).toEqual({ outcome: 'sent' });
    row = await ofChannel('email');
    expect(row).toMatchObject({ status: 'sent', attempts: 2, lastError: null });
    expect(row.sentAt).not.toBeNull();
    expect(h.sent.email).toHaveLength(1);
    // and a third time changes nothing
    job.attemptsStarted = 3;
    expect((await h.process(job)).outcome).toBe('noop');
    expect(h.sent.email).toHaveLength(1);
    void jobs;
  });

  it('a permanent failure is recorded and not retried; the retry endpoint is the way back, and it is idempotent', async () => {
    const { b, ofChannel, jobFor } = await ready();
    const h = deliveryHarness(t);
    h.control.emailError = Object.assign(
      new Error('550 mailbox unavailable for nobody@example.test'),
      { responseCode: 550 },
    );
    h.control.emailErrorTimes = 99;
    const email = await ofChannel('email');
    const job = jobFor(email.id);
    job.attemptsStarted = 1;
    expect(await h.process(job)).toEqual({ outcome: 'failed', reason: 'invalid_recipient' }); // no throw: the queue will not retry
    const row = await ofChannel('email');
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row.lastError).toMatch(/^permanent:invalid_recipient/);
    expect(row.lastError).not.toContain('nobody@example.test'); // no address in the stored error
    // visible to the people who run the business
    const failed = (await as(b.owner).get('/v1/automation/deliveries?status=failed').expect(200))
      .body.items as { id: string; lastError: string }[];
    expect(failed.map((f) => f.id)).toContain(email.id);
    expect((await as(b.manager).get('/v1/automation/deliveries?status=failed')).status).toBe(200);
    expect((await as(b.staff).get('/v1/automation/deliveries?status=failed')).status).toBe(403);
    // the retry endpoint queues it once, however often it is pressed
    const before = deliver.list().length;
    const r1 = await as(b.owner).post(`/v1/automation/deliveries/${email.id}/retry`).expect(200);
    const r2 = await as(b.owner).post(`/v1/automation/deliveries/${email.id}/retry`).expect(200);
    expect(r1.body.status).toBe('pending');
    expect(r2.body.status).toBe('pending');
    expect(deliver.list().length).toBe(before + 1);
    // a manager may read but not retry
    expect((await as(b.manager).post(`/v1/automation/deliveries/${email.id}/retry`)).status).toBe(
      403,
    );
    // it works the second time
    h.control.emailErrorTimes = 0;
    const retryJob = deliver.list().at(-1)!;
    retryJob.attemptsStarted = 1;
    expect(await h.process(retryJob)).toEqual({ outcome: 'sent' });
    expect(h.sent.email).toHaveLength(1);
    // retrying something that was sent never sends again
    await as(b.owner).post(`/v1/automation/deliveries/${email.id}/retry`).expect(200);
    expect(deliver.list().length).toBe(before + 1);
    expect((await ofChannel('email')).status).toBe('sent');
  });

  it('a worker that died after claiming does not make a duplicate: a live claim is respected, a redelivery takes over, once', async () => {
    const { b, ofChannel, jobFor } = await ready();
    const h = deliveryHarness(t);
    const email = await ofChannel('email');
    // "worker A" claims the delivery and dies before sending
    await t.db.withContext(
      ctxOf(b.tenantId),
      (tx) =>
        tx.$executeRaw`UPDATE notification_deliveries SET claimed_at = now(), attempts = attempts + 1 WHERE id = ${email.id}::uuid`,
    );
    const job = jobFor(email.id);
    // another worker looking at the same delivery while the lease is live does nothing
    job.attemptsStarted = 1;
    expect((await h.process(job)).outcome).toBe('noop');
    expect(h.sent.email).toHaveLength(0);
    // the queue redelivers (the previous attempt is over): the claim is taken over
    job.attemptsStarted = 2;
    expect(await h.process(job)).toEqual({ outcome: 'sent' });
    expect(h.sent.email).toHaveLength(1);
    expect(await ofChannel('email')).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('a push to a device the provider says is gone removes the device and skips the delivery', async () => {
    const { b, ofChannel, jobFor } = await ready();
    const h = deliveryHarness(t);
    h.control.pushProvider = {
      send: async (m) =>
        m.map((x) => ({
          token: x.token,
          status: 'error' as const,
          error: 'DeviceNotRegistered',
          deviceGone: true,
          permanent: true,
        })),
    };
    const push = await ofChannel('push');
    const job = jobFor(push.id);
    job.attemptsStarted = 1;
    expect(await h.process(job)).toEqual({ outcome: 'skipped', reason: 'device_not_registered' });
    expect(await ofChannel('push')).toMatchObject({
      status: 'skipped',
      lastError: 'device_not_registered',
    });
    expect(
      await t.db.withContext({ tenantId: b.tenantId, userId: b.owner.user.id }, (tx) =>
        tx.pushDevice.count(),
      ),
    ).toBe(0);
  });

  it('a person who left the business, or was disabled, is skipped, not mailed', async () => {
    const { b, ofChannel, jobFor } = await ready();
    const h = deliveryHarness(t);
    await t.db.global.user.update({
      where: { id: b.owner.user.id },
      data: { disabledAt: new Date() },
    });
    const email = await ofChannel('email');
    const job = jobFor(email.id);
    job.attemptsStarted = 1;
    expect(await h.process(job)).toEqual({ outcome: 'skipped', reason: 'recipient_disabled' });
    expect(h.sent.email).toHaveLength(0);
    await t.db.global.user.update({ where: { id: b.owner.user.id }, data: { disabledAt: null } });
  });
});

describe('queue wiring: a lost job is found again', () => {
  it('a delivery committed but never queued is re-queued by the tick, once', async () => {
    const b = await business();
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    deliver.fail = true; // the queue is down when the run finishes
    const result = await run(b.owner, 'LOW_STOCK');
    deliver.fail = false;
    // the run reports the failure on itself instead of a 500, and the data is safe
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('failed');
    expect(await countNotes(b.owner)).toBe(1);
    const pending = (await deliveriesOf(b.tenantId)).filter((d) => d.status === 'pending');
    expect(pending.length).toBe(5);
    // the retry endpoint re-runs the failed run: no new notification, and the deliveries are queued
    await as(b.owner).post(`/v1/automation/runs/${result.body.id}/retry`).expect(200);
    await drain(evaluate, (job) =>
      handleEvaluateJob(runtimeOf(t).deps, job.data, {
        jobId: job.id,
        attempt: job.attemptsStarted,
      }),
    );
    expect((await as(b.owner).get('/v1/automation/runs')).body.items[0]).toMatchObject({
      status: 'succeeded',
      attempts: 2,
    });
    expect(await countNotes(b.owner)).toBe(1);
    const queuedFor = deliver
      .list('deliver')
      .filter((j) => (j.data as { tenantId: string }).tenantId === b.tenantId);
    expect(queuedFor).toHaveLength(5);
  });

  it('the tick queues stale pending deliveries under their own id', async () => {
    const b = await business();
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    const q = fakeQueue();
    const runtime = runtimeOf(t);
    deliver.fail = true;
    await run(b.owner, 'LOW_STOCK');
    deliver.fail = false;
    // too young to be swept
    const young = await t.db.stalePendingDeliveries(60);
    expect(young.filter((d) => d.tenantId === b.tenantId)).toHaveLength(0);
    // age them
    await t.db.withContext(
      ctxOf(b.tenantId),
      (tx) =>
        tx.$executeRaw`UPDATE notification_deliveries SET created_at = now() - interval '10 minutes' WHERE tenant_id = ${b.tenantId}::uuid`,
    );
    const stale = (await t.db.stalePendingDeliveries(60, 1000)).filter(
      (d) => d.tenantId === b.tenantId,
    );
    expect(stale.length).toBe(5);
    const tickDeps = {
      db: t.db,
      queues: { evaluate: fakeQueue(), deliver: q },
      now: runtime.now,
      log: () => undefined,
    };
    await runAutomationTick(tickDeps);
    await runAutomationTick(tickDeps);
    expect(
      q.list('deliver').filter((j) => (j.data as { tenantId: string }).tenantId === b.tenantId),
    ).toHaveLength(5);
  });

  it('the cross-business reads are two functions and nothing wider', async () => {
    const b = await business();
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    const rules: Awaited<ReturnType<typeof t.db.enabledAutomationRules>> = [];
    for (let after: string | null = null; ;) {
      const page = await t.db.enabledAutomationRules(after, 500);
      rules.push(...page);
      if (page.length < 500) break;
      after = page.at(-1)!.id;
    }
    expect(rules.find((r) => r.tenantId === b.tenantId)).toMatchObject({
      kind: 'LOW_STOCK',
      timezone: 'Asia/Dhaka',
    });
    expect(Object.keys(rules[0]!).sort()).toEqual(['config', 'id', 'kind', 'tenantId', 'timezone']);
    // plain access outside a context still sees nothing
    expect(await t.db.withContext({}, (tx) => tx.automationRule.count())).toBe(0);
    expect(await t.db.withContext({}, (tx) => tx.notificationDelivery.count())).toBe(0);
    expect(await t.db.withContext({}, (tx) => tx.tenant.count())).toBe(0);
  });
});

describe('NEW_ORDER: event, catch-up, and a lost event', () => {
  it('an order created queues one event job; processing it, then the catch-up, announces it once', async () => {
    const b = await business();
    const item = await lowStockItem(t, b.owner.accessToken, { stock: 10, reorderPoint: 0 });
    await rule(b.owner, 'NEW_ORDER', { enabled: true }).expect(200);
    await wait(30);
    const order = await placeOrder(t, b.owner.accessToken, item.variantId);
    const events = evaluate
      .list('evaluate')
      .filter((j) => j.data.type === 'neworder' && j.data.tenantId === b.tenantId);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(`neworder__${order.id}`);
    expect(events[0]!.data).toEqual({ type: 'neworder', tenantId: b.tenantId, orderId: order.id });
    // the same job twice (a duplicate message): the run slot makes it a no-op
    for (let attempt = 1; attempt <= 2; attempt++)
      await handleEvaluateJob(runtimeOf(t).deps, events[0]!.data, {
        jobId: events[0]!.id,
        attempt,
      });
    expect(await countNotes(b.owner, 'NEW_ORDER')).toBe(1);
    const n = (await notes(b.staff)).items[0]!;
    expect(n.title).toBe(`New order #${order.orderNumber}`);
    expect(n.data).toMatchObject({ kind: 'NEW_ORDER', orderIds: [order.id] });
    // then the catch-up scan: the order is already announced
    expect((await run(b.owner, 'NEW_ORDER')).body).toMatchObject({
      status: 'succeeded',
      createdCount: 0,
    });
    expect(await countNotes(b.owner, 'NEW_ORDER')).toBe(1);
    // everyone with orders:read got one, and nobody two
    for (const k of ['owner', 'admin', 'manager', 'staff', 'accountant'] as const)
      expect(await countNotes(b[k], 'NEW_ORDER'), k).toBe(1);
  });

  it('a lost enqueue never fails the order; the catch-up scan announces it, once', async () => {
    const b = await business();
    const item = await lowStockItem(t, b.owner.accessToken, { stock: 10, reorderPoint: 0 });
    await rule(b.owner, 'NEW_ORDER', { enabled: true }).expect(200);
    await wait(30);
    evaluate.fail = true;
    const order = await placeOrder(t, b.owner.accessToken, item.variantId); // 201 even though the queue is down
    evaluate.fail = false;
    expect(evaluate.list().filter((j) => j.id === `neworder__${order.id}`)).toHaveLength(0);
    expect(await countNotes(b.owner, 'NEW_ORDER')).toBe(0);
    const caught = await run(b.owner, 'NEW_ORDER');
    expect(caught.body).toMatchObject({ status: 'succeeded', createdCount: 5 });
    expect(await countNotes(b.owner, 'NEW_ORDER')).toBe(1);
    expect((await notes(b.owner)).items[0]!.data.orderIds).toEqual([order.id]);
    // and if the event job turns up later, it adds nothing
    await handleEvaluateJob(runtimeOf(t).deps, {
      type: 'neworder',
      tenantId: b.tenantId,
      orderId: order.id,
    });
    expect(await countNotes(b.owner, 'NEW_ORDER')).toBe(1);
  });

  it('orders from before the rule was switched on are not announced', async () => {
    const b = await business();
    const item = await lowStockItem(t, b.owner.accessToken, { stock: 10, reorderPoint: 0 });
    await placeOrder(t, b.owner.accessToken, item.variantId);
    await wait(30);
    await rule(b.owner, 'NEW_ORDER', { enabled: true }).expect(200);
    expect((await run(b.owner, 'NEW_ORDER')).body).toMatchObject({ createdCount: 0 });
    await wait(30);
    const fresh = await placeOrder(t, b.owner.accessToken, item.variantId);
    expect((await run(b.owner, 'NEW_ORDER')).body).toMatchObject({ createdCount: 5 });
    expect((await notes(b.owner)).items[0]!.data.orderIds).toEqual([fresh.id]);
  });

  it('is private: no customer name, phone or address in the notification, the push payload or the email', async () => {
    const b = await business();
    const item = await lowStockItem(t, b.owner.accessToken, { stock: 10, reorderPoint: 0 });
    await rule(b.owner, 'NEW_ORDER', { enabled: true, channels: { email: true } }).expect(200);
    await as(b.owner)
      .put('/v1/notification-preferences', { items: [{ kind: 'NEW_ORDER', email: true }] })
      .expect(200);
    await as(b.owner)
      .post('/v1/push-devices', {
        token: `ExponentPushToken[priv-${b.tenantId.slice(0, 12)}]`,
        platform: 'ios',
      })
      .expect(200);
    await wait(30);
    await placeOrder(t, b.owner.accessToken, item.variantId, {
      customerName: 'Zubayer Hossain Khan',
    });
    const h = deliveryHarness(t);
    await run(b.owner, 'NEW_ORDER').expect(200);
    for (const job of deliver
      .pending()
      .filter((j) => (j.data as { tenantId: string }).tenantId === b.tenantId)) {
      job.attemptsStarted += 1;
      await h.process(job);
    }
    const everything = JSON.stringify([
      (await notes(b.owner)).items,
      h.sent,
      t.mail.to(b.owner.email, 'notification'),
      await t.db.withContext(ctxOf(b.tenantId), (tx) =>
        tx.notification.findMany({ where: { tenantId: b.tenantId } }),
      ),
    ]);
    expect(h.sent.email.length + h.sent.push.length).toBeGreaterThan(0);
    for (const secret of ['Zubayer', 'Khan', '0171', '+88017', 'Dhanmondi', 'Road 3', 'House 5'])
      expect(everything, secret).not.toContain(secret);
  });
});

describe('UNCONFIRMED_ORDER and DELAYED_ORDER (a clock that is moved, no waiting)', () => {
  const target = async (
    b: Biz,
    kind: AutomationKind,
    slot: string,
    at: Date,
  ): Promise<RunTarget> => ({
    tenantId: b.tenantId,
    ruleId: await ruleIdOf(b.owner, kind),
    kind,
    slotKey: slot,
    scheduledFor: at,
    trigger: 'scheduled',
  });
  const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

  it('reminds after N minutes, repeats, and stops after three reminders; confirming ends it', async () => {
    const b = await business();
    const item = await lowStockItem(t, b.owner.accessToken, { stock: 10, reorderPoint: 0 });
    await rule(b.owner, 'UNCONFIRMED_ORDER', {
      enabled: true,
      config: { afterMinutes: 10, repeatEveryMinutes: 5 },
    }).expect(200);
    const order = await placeOrder(t, b.owner.accessToken, item.variantId);
    const base = new Date();
    const deps = (now: Date) => ({ ...runtimeOf(t).deps, now: () => now });
    const go = async (minutes: number, i: number) =>
      executeRule(
        deps(at(base, minutes)),
        await target(b, 'UNCONFIRMED_ORDER', `scan:t${i}`, at(base, minutes)),
      );
    await go(5, 1); // too early
    expect(await countNotes(b.owner, 'UNCONFIRMED_ORDER')).toBe(0);
    await go(11, 2); // first reminder
    expect(await countNotes(b.owner, 'UNCONFIRMED_ORDER')).toBe(1);
    await go(13, 3); // too soon after the last one
    expect(await countNotes(b.owner, 'UNCONFIRMED_ORDER')).toBe(1);
    await go(17, 4); // second
    expect(await countNotes(b.owner, 'UNCONFIRMED_ORDER')).toBe(2);
    await go(23, 5); // third
    expect(await countNotes(b.owner, 'UNCONFIRMED_ORDER')).toBe(3);
    await go(40, 6); // the cap: never a fourth
    await go(80, 7);
    expect(await countNotes(b.owner, 'UNCONFIRMED_ORDER')).toBe(3);
    const n = (await notes(b.owner)).items[0]!;
    expect(n.title).toBe('1 order waiting for confirmation');
    expect(n.body).toContain(`#${order.orderNumber}`);
    expect(n.data).toMatchObject({ kind: 'UNCONFIRMED_ORDER', orderIds: [order.id] });
    // the same slot twice is a no-op even with new facts
    expect((await go(90, 7)).outcome).toBe('duplicate');
    // confirm it: the episode ends and nothing more comes
    await as(b.owner).post(`/v1/orders/${order.id}/status`, { status: 'confirmed' }).expect(200);
    await go(120, 8);
    expect(await countNotes(b.owner, 'UNCONFIRMED_ORDER')).toBe(3);
    expect(
      await t.db.withContext(ctxOf(b.tenantId), (tx) =>
        tx.automationState.count({ where: { tenantId: b.tenantId } }),
      ),
    ).toBe(0);
  });

  it('without a repeat, one reminder per order and a digest for several', async () => {
    const b = await business();
    const item = await lowStockItem(t, b.owner.accessToken, { stock: 10, reorderPoint: 0 });
    await rule(b.owner, 'UNCONFIRMED_ORDER', { enabled: true, config: { afterMinutes: 5 } }).expect(
      200,
    );
    const orders = [
      await placeOrder(t, b.owner.accessToken, item.variantId),
      await placeOrder(t, b.owner.accessToken, item.variantId),
    ];
    const base = new Date();
    const deps = (now: Date) => ({ ...runtimeOf(t).deps, now: () => now });
    await executeRule(
      deps(at(base, 6)),
      await target(b, 'UNCONFIRMED_ORDER', 'scan:a1', at(base, 6)),
    );
    await executeRule(
      deps(at(base, 20)),
      await target(b, 'UNCONFIRMED_ORDER', 'scan:a2', at(base, 20)),
    );
    const list = (await notes(b.owner)).items.filter((n) => n.kind === 'UNCONFIRMED_ORDER');
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe('2 orders waiting for confirmation');
    expect((list[0]!.data.orderIds as string[]).sort()).toEqual(orders.map((o) => o.id).sort());
  });

  it('DELAYED_ORDER: not delivered N hours after confirmed or shipped, once per order, and not when delivered', async () => {
    const b = await business();
    const item = await lowStockItem(t, b.owner.accessToken, { stock: 10, reorderPoint: 0 });
    await rule(b.owner, 'DELAYED_ORDER', { enabled: true, config: { afterHours: 24 } }).expect(200);
    const waiting = await placeOrder(t, b.owner.accessToken, item.variantId, { confirm: true }); // confirmed, never shipped
    const moving = await placeOrder(t, b.owner.accessToken, item.variantId, { confirm: true });
    for (const status of ['ready_to_ship', 'shipped'])
      await as(b.owner).post(`/v1/orders/${moving.id}/status`, { status }).expect(200);
    const done = await placeOrder(t, b.owner.accessToken, item.variantId, { confirm: true });
    for (const status of ['ready_to_ship', 'shipped', 'delivered'])
      await as(b.owner).post(`/v1/orders/${done.id}/status`, { status }).expect(200);
    const pending = await placeOrder(t, b.owner.accessToken, item.variantId); // never confirmed: that is the other rule's business
    const base = new Date();
    const deps = (now: Date) => ({ ...runtimeOf(t).deps, now: () => now });
    const go = async (hours: number, i: number) =>
      executeRule(
        deps(at(base, hours * 60)),
        await target(b, 'DELAYED_ORDER', `scan:d${i}`, at(base, hours * 60)),
      );
    await go(23, 1);
    expect(await countNotes(b.owner, 'DELAYED_ORDER')).toBe(0);
    await go(25, 2);
    const n = (await notes(b.owner)).items.find((x) => x.kind === 'DELAYED_ORDER')!;
    expect(n.title).toBe('2 orders running late');
    expect((n.data.orderIds as string[]).sort()).toEqual([waiting.id, moving.id].sort());
    expect(n.data.orderIds).not.toContain(done.id);
    expect(n.data.orderIds).not.toContain(pending.id);
    await go(30, 3);
    expect(await countNotes(b.owner, 'DELAYED_ORDER')).toBe(1);
  });
});

describe('COD_DISCREPANCY', () => {
  it('tells finance readers about open discrepancies once while they stay open, and not STAFF', async () => {
    const b = await business();
    const mk = (minor: number, key: string) =>
      t.db.withContext(ctxOf(b.tenantId), (tx) =>
        tx.discrepancy.create({
          data: {
            tenantId: b.tenantId,
            type: 'short_paid',
            subjectKey: key,
            expectedMinor: minor + 10_000,
            actualMinor: 10_000,
            message: 'Short paid',
          },
        }),
      );
    const small = await mk(1_000, 'shipment:small');
    const big = await mk(50_000, 'shipment:big');
    await rule(b.owner, 'COD_DISCREPANCY', {
      enabled: true,
      config: { minAmountMinor: 5_000 },
    }).expect(200);
    await run(b.owner, 'COD_DISCREPANCY').expect(200);
    // owner, admin, manager and accountant hold finance:read; staff does not
    for (const k of ['owner', 'admin', 'manager', 'accountant'] as const)
      expect(await countNotes(b[k], 'COD_DISCREPANCY'), k).toBe(1);
    expect(await countNotes(b.staff)).toBe(0);
    const n = (await notes(b.owner)).items[0]!;
    expect(n.data).toMatchObject({ kind: 'COD_DISCREPANCY', count: 1, discrepancyIds: [big.id] });
    // again: nothing new
    await run(b.owner, 'COD_DISCREPANCY').expect(200);
    expect(await countNotes(b.owner, 'COD_DISCREPANCY')).toBe(1);
    // lower the minimum: the small one is new
    await rule(b.owner, 'COD_DISCREPANCY', { config: {} }).expect(200);
    await run(b.owner, 'COD_DISCREPANCY').expect(200);
    expect(await countNotes(b.owner, 'COD_DISCREPANCY')).toBe(2);
    expect((await notes(b.owner)).items[0]!.data.discrepancyIds).toEqual([small.id]);
    // resolving ends the episode; reopening would announce it again
    await t.db.withContext(ctxOf(b.tenantId), (tx) =>
      tx.discrepancy.update({
        where: { id: big.id },
        data: {
          status: 'resolved',
          resolution: 'checked with the courier',
          resolvedAt: new Date(),
        },
      }),
    );
    await run(b.owner, 'COD_DISCREPANCY').expect(200);
    await t.db.withContext(ctxOf(b.tenantId), (tx) =>
      tx.discrepancy.update({
        where: { id: big.id },
        data: { status: 'open', resolution: null, resolvedAt: null },
      }),
    );
    await run(b.owner, 'COD_DISCREPANCY').expect(200);
    expect(await countNotes(b.owner, 'COD_DISCREPANCY')).toBe(3);
  });
});

describe('DAILY_REPORT and WEEKLY_REPORT: one per slot', () => {
  it('a manual run is that day’s report: once per person, and the scheduler does not send it again', async () => {
    const b = await business();
    const item = await lowStockItem(t, b.owner.accessToken, { stock: 10, reorderPoint: 0 });
    await placeOrder(t, b.owner.accessToken, item.variantId);
    await rule(b.owner, 'DAILY_REPORT', { enabled: true, config: { localTime: '20:00' } }).expect(
      200,
    );
    const first = await run(b.owner, 'DAILY_REPORT').expect(200);
    expect(first.body.slotKey).toMatch(/^daily:\d{4}-\d{2}-\d{2}$/);
    expect(first.body).toMatchObject({ status: 'succeeded', createdCount: 4 }); // owner, admin, manager, accountant
    const second = await run(b.owner, 'DAILY_REPORT').expect(200);
    expect(second.body.id).toBe(first.body.id); // the same slot: the same run, nothing new
    for (const k of ['owner', 'admin', 'manager', 'accountant'] as const)
      expect(await countNotes(b[k], 'DAILY_REPORT'), k).toBe(1);
    expect(await countNotes(b.staff)).toBe(0);
    const n = (await notes(b.owner)).items[0]!;
    expect(n.title).toMatch(/^Daily report \d{4}-\d{2}-\d{2}$/);
    expect(n.body).toMatch(/1 order, revenue ৳1,250\.00, 0 delivered, 0 cancelled/);
    // the scheduler's slot for the same day finds the run already there
    const out = await executeRule(runtimeOf(t).deps, {
      tenantId: b.tenantId,
      ruleId: first.body.ruleId,
      kind: 'DAILY_REPORT',
      slotKey: first.body.slotKey,
      scheduledFor: new Date(),
      trigger: 'scheduled',
    });
    expect(out.outcome).toBe('duplicate');
    expect(await countNotes(b.owner, 'DAILY_REPORT')).toBe(1);
  });

  it('the scheduler, driven by a fake clock, fires a slot once however many ticks and workers see it, and again next day', async () => {
    const b = await business();
    await rule(b.owner, 'DAILY_REPORT', { enabled: true, config: { localTime: '20:00' } }).expect(
      200,
    );
    await rule(b.owner, 'WEEKLY_REPORT', {
      enabled: true,
      config: { localTime: '09:00', weekday: 1 },
    }).expect(200); // Monday
    const q = fakeQueue();
    const tick = (iso: string) =>
      runAutomationTick({
        db: t.db,
        queues: { evaluate: q, deliver: fakeQueue() },
        now: () => new Date(iso),
        log: () => undefined,
      });
    const process = async (iso: string) =>
      drain(q, (job) =>
        handleEvaluateJob({ ...runtimeOf(t).deps, now: () => new Date(iso) }, job.data, {
          jobId: job.id,
          attempt: 1,
        }),
      );
    const mine = () => q.list().filter((j) => j.data.tenantId === b.tenantId);

    // Monday 30 March 2026, Dhaka (UTC+6). 19:59 local: nothing due for the daily; 09:00 weekly passed earlier that day.
    await tick('2026-03-30T13:59:00Z');
    expect(
      mine()
        .map((j) => j.data.slotKey)
        .filter((k) => String(k).startsWith('daily')),
    ).toEqual([]);
    expect(mine().map((j) => j.data.slotKey)).toContain('weekly:2026-W14');
    // 20:00 local: the daily is due
    await tick('2026-03-30T14:00:10Z');
    await tick('2026-03-30T14:01:10Z');
    await tick('2026-03-30T14:02:10Z'); // many ticks, one slot
    expect(mine().filter((j) => j.data.slotKey === 'daily:2026-03-30')).toHaveLength(1);
    await process('2026-03-30T14:02:30Z');
    expect(await countNotes(b.owner, 'DAILY_REPORT')).toBe(1);
    expect(await countNotes(b.owner, 'WEEKLY_REPORT')).toBe(1);
    // the process dies after fire and a second worker sees the same slot after the job was cleaned up: still one
    q.jobs.clear();
    await tick('2026-03-30T15:00:00Z');
    await process('2026-03-30T15:00:05Z');
    expect(await countNotes(b.owner, 'DAILY_REPORT')).toBe(1);
    expect(await countNotes(b.owner, 'WEEKLY_REPORT')).toBe(1);
    // downtime catch-up inside the same local day fires a missed report once ... and the next local day is a new slot
    await tick('2026-03-31T14:00:10Z');
    await process('2026-03-31T14:00:30Z');
    expect(await countNotes(b.owner, 'DAILY_REPORT')).toBe(2);
    expect(await countNotes(b.owner, 'WEEKLY_REPORT')).toBe(1); // Tuesday: not the weekly's day
    const runs = (await as(b.owner).get('/v1/automation/runs?kind=DAILY_REPORT').expect(200)).body
      .items as { slotKey: string; trigger: string }[];
    expect(runs.map((r) => r.slotKey).sort()).toEqual(['daily:2026-03-30', 'daily:2026-03-31']);
    expect(new Set(runs.map((r) => r.trigger))).toEqual(new Set(['scheduled']));
  });

  it('the time zone of the business decides the local date of the slot', async () => {
    const b = await business();
    await as(b.owner).patch('/v1/tenant', { timezone: 'America/New_York' }).expect(200);
    await rule(b.owner, 'DAILY_REPORT', { enabled: true, config: { localTime: '09:00' } }).expect(
      200,
    );
    const q = fakeQueue();
    const tick = (iso: string) =>
      runAutomationTick({
        db: t.db,
        queues: { evaluate: q, deliver: fakeQueue() },
        now: () => new Date(iso),
        log: () => undefined,
      });
    const keys = () =>
      q
        .list()
        .filter((j) => j.data.tenantId === b.tenantId)
        .map((j) => j.data.slotKey);
    await tick('2026-03-08T12:59:00Z'); // 08:59 EDT (clocks went forward that morning): not yet
    expect(keys()).toEqual([]);
    await tick('2026-03-08T13:00:00Z'); // 09:00 EDT
    expect(keys()).toEqual(['daily:2026-03-08']);
  });
});

describe('retrying runs', () => {
  it('only a failed run is queued again, once, and then runs to success', async () => {
    const b = await business();
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    const ok = await run(b.owner, 'LOW_STOCK').expect(200);
    // retrying a succeeded run changes nothing
    const before = evaluate.list().length;
    expect(
      (await as(b.owner).post(`/v1/automation/runs/${ok.body.id}/retry`).expect(200)).body.status,
    ).toBe('succeeded');
    expect(evaluate.list().length).toBe(before);
    // make one fail, as if the worker had crashed mid-way
    await t.db.withContext(ctxOf(b.tenantId), (tx) =>
      tx.automationRun.update({
        where: { id: ok.body.id },
        data: { status: 'failed', error: 'boom' },
      }),
    );
    const failed = (await as(b.owner).get('/v1/automation/runs?status=failed').expect(200)).body
      .items as { id: string }[];
    expect(failed.map((r) => r.id)).toEqual([ok.body.id]);
    const r1 = await as(b.owner).post(`/v1/automation/runs/${ok.body.id}/retry`).expect(200);
    const r2 = await as(b.owner).post(`/v1/automation/runs/${ok.body.id}/retry`).expect(200);
    expect(r1.body.status).toBe('queued');
    expect(r2.body.status).toBe('queued');
    expect(evaluate.list().length).toBe(before + 1);
    const job = evaluate.list().at(-1)!;
    expect(job.data).toEqual({ type: 'retry-run', tenantId: b.tenantId, runId: ok.body.id });
    await handleEvaluateJob(runtimeOf(t).deps, job.data, { jobId: job.id, attempt: 1 });
    expect((await as(b.owner).get('/v1/automation/runs').expect(200)).body.items[0]).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      error: null,
    });
    expect(await countNotes(b.owner)).toBe(1); // the retry added nothing: it was announced the first time
  });

  it('a run that a crashed worker left running is taken over by the redelivery, not by a second worker', async () => {
    const b = await business();
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    const ruleId = await ruleIdOf(b.owner, 'LOW_STOCK');
    const target: RunTarget = {
      tenantId: b.tenantId,
      ruleId,
      kind: 'LOW_STOCK',
      slotKey: 'scan:20990101T0000Z',
      scheduledFor: new Date(),
      trigger: 'scheduled',
    };
    const deps = runtimeOf(t).deps;
    // worker A claims the slot and dies
    expect((await claimRun(deps, target, false)).execute).toBe(true);
    // worker B (first attempt) sees it running and leaves it alone
    expect((await executeRule(deps, target, { attempt: 1 })).outcome).toBe('duplicate');
    expect(await countNotes(b.owner)).toBe(0);
    // the queue redelivers: the run is taken over and completes once
    expect((await executeRule(deps, target, { attempt: 2 })).outcome).toBe('executed');
    expect((await executeRule(deps, target, { attempt: 3 })).outcome).toBe('duplicate');
    expect(await countNotes(b.owner)).toBe(1);
    const runs = (await as(b.owner).get('/v1/automation/runs').expect(200)).body.items;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', attempts: 2, createdCount: 5 });
  });
});

describe('notifications API', () => {
  it('lists newest first with a cursor and an unread filter, counts, and marks read idempotently', async () => {
    const b = await business();
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    for (let i = 0; i < 3; i++) {
      await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
      await run(b.owner, 'LOW_STOCK').expect(200);
    }
    expect((await as(b.owner).get('/v1/notifications/unread-count').expect(200)).body).toEqual({
      count: 3,
    });
    const p1 = await notes(b.owner, '?limit=2');
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await notes(b.owner, `?limit=2&cursor=${p1.nextCursor}`);
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    const all = [...p1.items, ...p2.items];
    expect(new Set(all.map((n) => n.id)).size).toBe(3);
    // mark one read: twice keeps the first read time
    const first = (await as(b.owner).post(`/v1/notifications/${all[0]!.id}/read`).expect(200)).body;
    expect(first.readAt).not.toBeNull();
    await wait(15);
    const again = (await as(b.owner).post(`/v1/notifications/${all[0]!.id}/read`).expect(200)).body;
    expect(again.readAt).toBe(first.readAt);
    expect((await as(b.owner).get('/v1/notifications/unread-count')).body).toEqual({ count: 2 });
    expect((await notes(b.owner, '?unread=true')).items).toHaveLength(2);
    expect((await notes(b.owner, '?unread=false')).items).toHaveLength(3);
    // someone else's notification is 404, and does not change
    const theirs = (await notes(b.staff)).items[0]!;
    expect((await as(b.owner).post(`/v1/notifications/${theirs.id}/read`)).status).toBe(404);
    expect((await notes(b.staff, '?unread=true')).items).toHaveLength(3);
    // read all
    expect((await as(b.owner).post('/v1/notifications/read-all').expect(200)).body).toEqual({
      updated: 2,
    });
    expect((await as(b.owner).get('/v1/notifications/unread-count')).body).toEqual({ count: 0 });
    expect((await as(b.staff).get('/v1/notifications/unread-count')).body).toEqual({ count: 3 });
  });

  it('a person with in-app off still gets the push, but nothing in the list or the count', async () => {
    const b = await business();
    await as(b.staff)
      .put('/v1/notification-preferences', { items: [{ kind: 'LOW_STOCK', inApp: false }] })
      .expect(200);
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    await run(b.owner, 'LOW_STOCK').expect(200);
    expect((await notes(b.staff)).items).toHaveLength(0);
    expect((await as(b.staff).get('/v1/notifications/unread-count')).body).toEqual({ count: 0 });
    const mine = (await deliveriesOf(b.tenantId))
      .filter((d) => d.notification.userId === b.staff.user.id)
      .map((d) => d.channel);
    expect(mine).toEqual(['push']);
  });

  it('preferences default to in-app and push on, email off, and say which kinds a role can receive', async () => {
    const b = await business();
    const prefs = (await as(b.staff).get('/v1/notification-preferences').expect(200)).body
      .items as {
      kind: string;
      inApp: boolean;
      push: boolean;
      email: boolean;
      available: boolean;
    }[];
    expect(prefs).toHaveLength(7);
    expect(prefs.every((p) => p.inApp && p.push && !p.email)).toBe(true);
    expect(prefs.find((p) => p.kind === 'LOW_STOCK')!.available).toBe(true);
    expect(prefs.find((p) => p.kind === 'DAILY_REPORT')!.available).toBe(false);
    const after = (
      await as(b.staff)
        .put('/v1/notification-preferences', {
          items: [{ kind: 'NEW_ORDER', push: false, email: true }],
        })
        .expect(200)
    ).body.items;
    expect(after.find((p: { kind: string }) => p.kind === 'NEW_ORDER')).toMatchObject({
      inApp: true,
      push: false,
      email: true,
    });
    expect((await as(b.staff).put('/v1/notification-preferences', { items: [] })).status).toBe(400);
    // someone else's preferences are untouched
    expect(
      (await as(b.owner).get('/v1/notification-preferences')).body.items.find(
        (p: { kind: string }) => p.kind === 'NEW_ORDER',
      ),
    ).toMatchObject({ push: true, email: false });
  });
});

describe('push devices', () => {
  const TOKEN = (s: string) => `ExponentPushToken[${s}-lifecycle-token]`;
  it('registers by token (an upsert), moves with the phone, and is removed by its owner only', async () => {
    const b = await business();
    const token = TOKEN(b.tenantId.slice(0, 8));
    const a1 = await as(b.owner).post('/v1/push-devices', { token, platform: 'ios' }).expect(200);
    const a2 = await as(b.owner).post('/v1/push-devices', { token, platform: 'ios' }).expect(200);
    expect(a2.body.id).toBe(a1.body.id);
    expect(a1.body).toMatchObject({ platform: 'ios', provider: 'dev' });
    const mine = () =>
      t.db.withContext({ tenantId: b.tenantId, userId: b.owner.user.id }, (tx) =>
        tx.pushDevice.findMany({ where: { token, userId: b.owner.user.id } }),
      );
    expect(await mine()).toHaveLength(1);
    // somebody else cannot delete it
    await as(b.staff)
      .del(`/v1/push-devices/${encodeURIComponent(token)}`)
      .expect(200);
    expect(await mine()).toHaveLength(1);
    // the phone changes hands: the staff member signs in and registers the same token; it is theirs now, and still one row
    const s1 = await as(b.staff)
      .post('/v1/push-devices', { token, platform: 'android' })
      .expect(200);
    expect(s1.body.platform).toBe('android');
    expect(await mine()).toHaveLength(0);
    const owned = await t.db.withContext({ tenantId: b.tenantId, userId: b.staff.user.id }, (tx) =>
      tx.pushDevice.findMany({ where: { token } }),
    );
    expect(owned).toHaveLength(1);
    expect(owned[0]!.userId).toBe(b.staff.user.id);
    // sign-out removes it; repeating is fine
    await as(b.staff)
      .del(`/v1/push-devices/${encodeURIComponent(token)}`)
      .expect(200);
    await as(b.staff)
      .del(`/v1/push-devices/${encodeURIComponent(token)}`)
      .expect(200);
    expect(
      await t.db.withContext({ tenantId: b.tenantId, userId: b.staff.user.id }, (tx) =>
        tx.pushDevice.count({ where: { token } }),
      ),
    ).toBe(0);
    // validation
    expect(
      (await as(b.owner).post('/v1/push-devices', { token: 'short', platform: 'ios' })).status,
    ).toBe(400);
    expect(
      (await as(b.owner).post('/v1/push-devices', { token, platform: 'symbian' })).status,
    ).toBe(400);
  });

  it('the database function refuses to register a device for another user', async () => {
    const b = await business();
    await expect(
      t.db.withContext(
        { tenantId: b.tenantId, userId: b.owner.user.id },
        (tx) =>
          tx.$queryRaw`SELECT * FROM upsert_push_device(${b.staff.user.id}::uuid, 'ExponentPushToken[forged-device]', 'ios'::"PushPlatform", 'dev'::"PushProviderKind")`,
      ),
    ).rejects.toThrow();
  });
});

describe('tenant isolation of everything new', () => {
  it('another business cannot see or change rules, runs, notifications, deliveries, preferences, consents or devices', async () => {
    const a = await business();
    const other = await business();
    await as(a.owner)
      .put('/v1/notification-preferences', { items: [{ kind: 'LOW_STOCK', email: true }] })
      .expect(200);
    const token = `ExponentPushToken[iso-${a.tenantId.slice(0, 10)}]`;
    await as(a.owner).post('/v1/push-devices', { token, platform: 'ios' }).expect(200);
    await rule(a.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    await lowStockItem(t, a.owner.accessToken, { stock: 1, reorderPoint: 5 });
    const ran = await run(a.owner, 'LOW_STOCK').expect(200);
    const mine = (await notes(a.owner)).items[0]!;
    const delivery = (await deliveriesOf(a.tenantId))[0]!;

    // through the API: B sees none of it, and cannot touch it by id
    expect(
      (await as(other.owner).get('/v1/automation/rules').expect(200)).body.rules.every(
        (r: { configured: boolean }) => !r.configured,
      ),
    ).toBe(true);
    expect((await as(other.owner).get('/v1/automation/runs').expect(200)).body.items).toEqual([]);
    expect((await as(other.owner).get('/v1/automation/deliveries').expect(200)).body.items).toEqual(
      [],
    );
    expect((await notes(other.owner)).items).toEqual([]);
    expect((await as(other.owner).post(`/v1/automation/runs/${ran.body.id}/retry`)).status).toBe(
      404,
    );
    expect(
      (await as(other.owner).post(`/v1/automation/deliveries/${delivery.id}/retry`)).status,
    ).toBe(404);
    expect((await as(other.owner).post(`/v1/notifications/${mine.id}/read`)).status).toBe(404);
    await run(other.owner, 'LOW_STOCK').expect(409); // their rule does not exist
    expect((await notes(a.owner, '?unread=true')).items).toHaveLength(1);

    // in the database, as the runtime role
    const zero = await t.db.withContext(ctxOf(other.tenantId), async (tx) => ({
      rules: await tx.automationRule.count({ where: { tenantId: a.tenantId } }),
      runs: await tx.automationRun.count({ where: { tenantId: a.tenantId } }),
      state: await tx.automationState.count({ where: { tenantId: a.tenantId } }),
      notifications: await tx.notification.count({ where: { tenantId: a.tenantId } }),
      deliveries: await tx.notificationDelivery.count({ where: { tenantId: a.tenantId } }),
      prefs: await tx.notificationPreference.count({ where: { tenantId: a.tenantId } }),
      consents: await tx.messagingConsent.count({ where: { tenantId: a.tenantId } }),
      devices: await tx.pushDevice.count({ where: { token } }),
    }));
    expect(zero).toEqual({
      rules: 0,
      runs: 0,
      state: 0,
      notifications: 0,
      deliveries: 0,
      prefs: 0,
      consents: 0,
      devices: 0,
    });
    // and cannot write into A's business
    await expect(
      t.db.withContext(ctxOf(other.tenantId), (tx) =>
        tx.notification.create({
          data: {
            tenantId: a.tenantId,
            userId: a.owner.user.id,
            kind: 'LOW_STOCK',
            title: 'x',
            body: 'y',
            dedupeKey: 'evil',
          },
        }),
      ),
    ).rejects.toThrow();
    expect(
      (
        await t.db.withContext(ctxOf(other.tenantId), (tx) =>
          tx.automationRule.updateMany({
            where: { tenantId: a.tenantId },
            data: { enabled: false },
          }),
        )
      ).count,
    ).toBe(0);
    // while A itself (and the worker, in A's context) sees its own, including its members' devices
    expect(
      await t.db.withContext(ctxOf(a.tenantId), (tx) => tx.pushDevice.count({ where: { token } })),
    ).toBe(1);
    // a composite foreign key stops a row in A from naming B's parent
    await expect(
      t.db.withContext(ctxOf(a.tenantId), (tx) =>
        tx.automationRun.create({
          data: {
            tenantId: a.tenantId,
            ruleId: ran.body.ruleId,
            kind: 'LOW_STOCK',
            slotKey: 'x',
            trigger: 'manual',
            scheduledFor: new Date(),
          },
        }),
      ),
    ).resolves.toBeDefined(); // its own rule is fine ...
    const bRule = await rule(other.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    const bRuleId = (
      await t.db.withContext(ctxOf(other.tenantId), (tx) =>
        tx.automationRule.findFirstOrThrow({
          where: { tenantId: other.tenantId, kind: 'LOW_STOCK' },
        }),
      )
    ).id;
    expect(bRule.status).toBe(200);
    await expect(
      t.db.withContext(ctxOf(a.tenantId), (tx) =>
        tx.automationRun.create({
          data: {
            tenantId: a.tenantId,
            ruleId: bRuleId,
            kind: 'LOW_STOCK',
            slotKey: 'y',
            trigger: 'manual',
            scheduledFor: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(); // ... another business's rule is not
  });

  it('the unique constraints that make repeats impossible exist', async () => {
    const b = await business();
    await rule(b.owner, 'LOW_STOCK', { enabled: true }).expect(200);
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    await run(b.owner, 'LOW_STOCK').expect(200);
    const n = await t.db.withContext(ctxOf(b.tenantId), (tx) =>
      tx.notification.findFirstOrThrow({
        where: { tenantId: b.tenantId, userId: b.owner.user.id },
      }),
    );
    await expect(
      t.db.withContext(ctxOf(b.tenantId), (tx) =>
        tx.notification.create({
          data: {
            tenantId: b.tenantId,
            userId: n.userId,
            kind: n.kind,
            title: 't',
            body: 'b',
            dedupeKey: n.dedupeKey,
          },
        }),
      ),
    ).rejects.toThrow(/Unique/i);
    await expect(
      t.db.withContext(ctxOf(b.tenantId), (tx) =>
        tx.notificationDelivery.create({
          data: { tenantId: b.tenantId, notificationId: n.id, channel: 'push' },
        }),
      ),
    ).rejects.toThrow(/Unique/i);
    // one run per (rule, slot)
    const existing = await t.db.withContext(ctxOf(b.tenantId), (tx) =>
      tx.automationRun.findFirstOrThrow({ where: { tenantId: b.tenantId } }),
    );
    await expect(
      t.db.withContext(ctxOf(b.tenantId), (tx) =>
        tx.automationRun.create({
          data: {
            tenantId: b.tenantId,
            ruleId: existing.ruleId,
            kind: 'LOW_STOCK',
            slotKey: existing.slotKey,
            trigger: 'scheduled',
            scheduledFor: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/Unique/i);
  });
});

describe('processDelivery with nothing configured', () => {
  it('email with no sender is skipped, not failed', async () => {
    const b = await business();
    await as(b.owner)
      .put('/v1/notification-preferences', { items: [{ kind: 'LOW_STOCK', email: true }] })
      .expect(200);
    await rule(b.owner, 'LOW_STOCK', { enabled: true, channels: { email: true } }).expect(200);
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    await run(b.owner, 'LOW_STOCK').expect(200);
    const email = (await deliveriesOf(b.tenantId)).find((d) => d.channel === 'email')!;
    const out = await processDelivery(
      {
        db: t.db,
        now: () => new Date(),
        log: () => undefined,
        providers: { push: {}, email: null, sms: null, whatsapp: null },
      },
      { tenantId: b.tenantId, deliveryId: email.id },
    );
    expect(out).toEqual({ outcome: 'skipped', reason: 'channel_not_configured' });
  });
});
