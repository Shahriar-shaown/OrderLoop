import type { AutomationKind } from '@orderloop/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createTestApp, registerTenant, type TestApp } from './app.js';
import { deliveryHarness, fakeQueue, lowStockItem, type FakeQueue } from './automation-helpers.js';

/** SMS is on through the console provider (it only logs); WhatsApp is left unconfigured. No vendor is ever called. */
let t: TestApp;
let deliver: FakeQueue;
beforeAll(async () => {
  deliver = fakeQueue();
  t = await createTestApp(
    { SMS_PROVIDER: 'console', WHATSAPP_PROVIDER: 'none' },
    { automation: { evaluate: fakeQueue(), deliver } },
  );
});
afterAll(() => t.close());

type Who = { accessToken: string };
const as = (who: Who) => ({
  get: (p: string) => t.http.get(p).set(bearer(who.accessToken)),
  put: (p: string, b: object = {}) => t.http.put(p).set(bearer(who.accessToken)).send(b),
  post: (p: string, b: object = {}) => t.http.post(p).set(bearer(who.accessToken)).send(b),
});
const rule = (who: Who, kind: AutomationKind, body: object) =>
  as(who).put(`/v1/automation/rules/${kind}`, body);

async function business() {
  const owner = await registerTenant(t);
  const staff = await addMember(t, owner, 'STAFF');
  const accountant = await addMember(t, owner, 'ACCOUNTANT');
  return { owner, staff, accountant, tenantId: owner.tenant.id };
}
const smsDeliveries = (tenantId: string) =>
  t.db.withContext({ tenantId }, (tx) =>
    tx.notificationDelivery.findMany({
      where: { tenantId, channel: 'sms' },
      include: { notification: { select: { userId: true } } },
    }),
  );

describe('sms and whatsapp: only with a provider, and only with consent', () => {
  it('tells the screens what is available', async () => {
    const b = await business();
    expect((await as(b.owner).get('/v1/automation/rules').expect(200)).body.providers).toEqual({
      push: 'dev',
      sms: true,
      whatsapp: false,
      email: true,
    });
    const consents = (await as(b.staff).get('/v1/messaging-consents').expect(200)).body.items;
    expect(consents).toEqual([
      {
        channel: 'sms',
        configured: true,
        granted: false,
        phone: null,
        grantedAt: null,
        revokedAt: null,
      },
      {
        channel: 'whatsapp',
        configured: false,
        granted: false,
        phone: null,
        grantedAt: null,
        revokedAt: null,
      },
    ]);
  });

  it('whatsapp is 422 channel_not_configured, for a rule and for a consent', async () => {
    const b = await business();
    const res = await rule(b.owner, 'LOW_STOCK', {
      enabled: true,
      channels: { whatsapp: true },
    }).expect(422);
    expect(res.body.code).toBe('channel_not_configured');
    const consent = await as(b.staff)
      .put('/v1/messaging-consents', { channel: 'whatsapp', granted: true, phone: '01712345678' })
      .expect(422);
    expect(consent.body.code).toBe('channel_not_configured');
    expect(
      (await as(b.owner).get('/v1/automation/rules')).body.rules.every(
        (r: { configured: boolean }) => !r.configured,
      ),
    ).toBe(true);
  });

  it('sms is 422 consent_required until someone who would receive it has agreed', async () => {
    const b = await business();
    const none = await rule(b.owner, 'LOW_STOCK', {
      enabled: true,
      channels: { sms: true },
    }).expect(422);
    expect(none.body.code).toBe('consent_required');
    // a consent from someone who cannot receive this kind (staff have no finance:read) does not count for a finance kind
    await as(b.staff)
      .put('/v1/messaging-consents', { channel: 'sms', granted: true, phone: '01712345678' })
      .expect(200);
    expect(
      (
        await rule(b.owner, 'COD_DISCREPANCY', { enabled: true, channels: { sms: true } }).expect(
          422,
        )
      ).body.code,
    ).toBe('consent_required');
    // for low stock they can receive it: allowed
    const ok = await rule(b.owner, 'LOW_STOCK', { enabled: true, channels: { sms: true } }).expect(
      200,
    );
    expect(ok.body.channels.sms).toBe(true);
  });

  it('consent needs a valid Bangladeshi number, is the caller’s own, and can be revoked and given again', async () => {
    const b = await business();
    expect(
      (
        await as(b.staff)
          .put('/v1/messaging-consents', { channel: 'sms', granted: true })
          .expect(400)
      ).body.code,
    ).toBe('validation_failed');
    const bad = await as(b.staff)
      .put('/v1/messaging-consents', { channel: 'sms', granted: true, phone: '12345' })
      .expect(400);
    expect(bad.body.errors[0].path).toBe('body.phone');
    const granted = await as(b.staff)
      .put('/v1/messaging-consents', { channel: 'sms', granted: true, phone: '01712-345678' })
      .expect(200);
    expect(granted.body.items[0]).toMatchObject({
      channel: 'sms',
      granted: true,
      phone: '+8801712345678',
      revokedAt: null,
    });
    // the owner's own consent is separate
    expect((await as(b.owner).get('/v1/messaging-consents')).body.items[0]).toMatchObject({
      granted: false,
      phone: null,
    });
    const revoked = await as(b.staff)
      .put('/v1/messaging-consents', { channel: 'sms', granted: false })
      .expect(200);
    expect(revoked.body.items[0]).toMatchObject({ granted: false, revokedAt: expect.any(String) });
    expect(
      (
        await as(b.staff)
          .put('/v1/messaging-consents', { channel: 'sms', granted: true, phone: '01812345678' })
          .expect(200)
      ).body.items[0],
    ).toMatchObject({
      granted: true,
      phone: '+8801812345678',
      revokedAt: null,
    });
    const audit = await t.db.withContext({ tenantId: b.tenantId }, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: b.tenantId, action: { startsWith: 'messaging.consent' } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audit.map((a) => a.action)).toEqual([
      'messaging.consent_granted',
      'messaging.consent_revoked',
      'messaging.consent_granted',
    ]);
    expect(JSON.stringify(audit.map((a) => a.metadata))).not.toContain('0171'); // the number is not in the audit trail
  });

  it('with the provider and the consent, a notification reaches the console provider; without consent nothing is created or sent', async () => {
    const b = await business();
    await as(b.staff)
      .put('/v1/messaging-consents', { channel: 'sms', granted: true, phone: '01712345678' })
      .expect(200);
    await rule(b.owner, 'LOW_STOCK', {
      enabled: true,
      channels: { sms: true, push: false },
    }).expect(200);
    await lowStockItem(t, b.owner.accessToken, {
      stock: 1,
      reorderPoint: 5,
      name: 'Cotton panjabi',
    });
    await as(b.owner).post('/v1/automation/rules/LOW_STOCK/run').expect(200);
    // only the consenting member gets an sms delivery
    const rows = await smsDeliveries(b.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notification.userId).toBe(b.staff.user.id);
    const job = deliver.list('deliver').find((j) => j.data.deliveryId === rows[0]!.id)!;
    const h = deliveryHarness(t);
    job.attemptsStarted = 1;
    expect(await h.process(job)).toEqual({ outcome: 'sent' });
    expect(h.sent.sms).toHaveLength(1);
    expect(h.sent.sms[0]).toMatchObject({
      channel: 'sms',
      to: '+8801712345678',
      idempotencyKey: rows[0]!.id,
    });
    expect(h.sent.sms[0]!.body).toContain('Low stock');
    expect(h.sent.sms[0]!.body).not.toMatch(/Rina|Dhanmondi/);
    // run it again and send it again: still one
    job.attemptsStarted = 2;
    expect((await h.process(job)).outcome).toBe('noop');
    expect(h.sent.sms).toHaveLength(1);
    expect((await smsDeliveries(b.tenantId))[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('consent revoked after the delivery was created: it is skipped at send time, never sent', async () => {
    const b = await business();
    await as(b.staff)
      .put('/v1/messaging-consents', { channel: 'sms', granted: true, phone: '01712345678' })
      .expect(200);
    await rule(b.owner, 'LOW_STOCK', { enabled: true, channels: { sms: true } }).expect(200);
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    await as(b.owner).post('/v1/automation/rules/LOW_STOCK/run').expect(200);
    const row = (await smsDeliveries(b.tenantId))[0]!;
    await as(b.staff).put('/v1/messaging-consents', { channel: 'sms', granted: false }).expect(200);
    const h = deliveryHarness(t);
    const job = deliver.list('deliver').find((j) => j.data.deliveryId === row.id)!;
    job.attemptsStarted = 1;
    expect(await h.process(job)).toEqual({ outcome: 'skipped', reason: 'no_consent' });
    expect(h.sent.sms).toHaveLength(0);
    // and a later notification creates no sms delivery for them at all
    await lowStockItem(t, b.owner.accessToken, { stock: 1, reorderPoint: 5 });
    await as(b.owner).post('/v1/automation/rules/LOW_STOCK/run').expect(200);
    expect(await smsDeliveries(b.tenantId)).toHaveLength(1);
  });
});
