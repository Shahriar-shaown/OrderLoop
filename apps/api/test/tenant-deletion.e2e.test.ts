import { randomUUID } from 'node:crypto';
import { processSocialEvent } from '@orderloop/automation';
import { fakeNetwork } from '@orderloop/courier-sdk';
import { TENANT_TABLES } from '@orderloop/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  createProduct,
  createTestApp,
  PASSWORD,
  registerTenant,
  uniqueEmail,
  type TestApp,
} from './app.js';
import { drain, fakeQueue, type FakeQueue } from './automation-helpers.js';
import { tenantRowCounts, withAdmin } from './deletion-helpers.js';

/**
 * Deleting a whole business (docs/privacy-and-deletion.md): the owner asks (name and password), the business stops working at
 * once and its credentials go, and after the grace period the worker's purge deletes every row. Nothing here is a legal claim.
 */
let t: TestApp;
let net = fakeNetwork({});
let consignment = 9000;
let metaQueue: FakeQueue;
beforeAll(async () => {
  metaQueue = fakeQueue();
  t = await createTestApp(
    { META_MODE: 'mock', TIKTOK_MODE: 'mock' },
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
type Owner = Awaited<ReturnType<typeof registerTenant>>;
let seq = 0;
const key = (p = 'td') => `${p}-${Date.now()}-${++seq}`;
const call = (who: Who) => ({
  get: (path: string) => t.http.get(path).set(bearer(who.accessToken)),
  post: (path: string, body: object = {}) =>
    t.http.post(path).set(bearer(who.accessToken)).send(body),
  put: (path: string, body: object) => t.http.put(path).set(bearer(who.accessToken)).send(body),
  patch: (path: string, body: object) => t.http.patch(path).set(bearer(who.accessToken)).send(body),
});
const request = (who: Who, body: object) => call(who).post('/v1/tenant/delete-request', body);
const status = (who: Who) => call(who).get('/v1/tenant/deletion-status');
const TOKEN = 'steadfast-token-0123456789';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

/**
 * A business with something in EVERY tenant table: made through the API wherever there is a route, and with a few direct
 * inserts (as the database owner) for the rows only a background job writes. The purge test asserts none is empty.
 */
async function fullBusiness(tenantName: string) {
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
  const owner = await registerTenant(t, { tenantName });
  const api = call(owner);
  const tenantId = owner.tenant.id;
  const conn = await t.http
    .patch('/v1/couriers/steadfast')
    .set(bearer(owner.accessToken))
    .send({
      environment: 'production',
      credentials: { apiKey: 'api-key-secret', secretKey: 'secret-key-secret' },
      webhookSecret: TOKEN,
    })
    .expect(200);
  const hookPath = new URL(conn.body.connection.webhookUrl as string).pathname;

  const category = (await api.post('/v1/categories', { name: 'Shirts' }).expect(201)).body;
  await api.post('/v1/suppliers', { name: 'Dhaka Textiles' }).expect(201);
  const { variant } = await createProduct(t, owner.accessToken, {
    priceMinor: 100_000,
    categoryId: category.id,
  });
  await api.post('/v1/inventory/receive', { variantId: variant.id, quantity: 50 }).expect(201);
  await api
    .post('/v1/customers', { name: 'Rahim Uddin', phone: '01712345678', idempotencyKey: key('cu') })
    .expect(201);

  const order = await api
    .post('/v1/orders', {
      customer: { name: 'Rahim Uddin', phone: '01712345678' },
      address: {
        recipientName: 'Rahim Uddin',
        phone: '01712345678',
        line1: 'House 12, Road 5, Dhanmondi',
        area: 'Dhanmondi',
        district: 'Dhaka',
        division: 'Dhaka',
      },
      items: [{ variantId: variant.id, quantity: 2 }],
      deliveryChargeMinor: 6_000,
      idempotencyKey: key('ord'),
      confirm: true,
    })
    .expect(201);
  await api.post(`/v1/orders/${order.body.id}/status`, { status: 'ready_to_ship' }).expect(200);
  const booked = await api
    .post(`/v1/orders/${order.body.id}/shipments`, {
      provider: 'steadfast',
      idempotencyKey: key('bk'),
    })
    .expect(201);
  await t.http
    .post(hookPath)
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({
      notification_type: 'delivery_status',
      consignment_id: Number(booked.body.consignmentId),
      invoice: `OL-${order.body.orderNumber}`,
      cod_amount: 2060,
      status: 'delivered',
      delivery_charge: 60,
      tracking_message: 'Delivered',
      updated_at: '2026-10-18 10:00:00',
    })
    .expect(200);
  const d = today();
  const csv = [
    'transaction_id,consignment_id,tracking_code,reference,phone,date,type,collected,delivery_charge,cod_fee,return_charge,other_deduction,net,note',
    `T1,${booked.body.consignmentId},,OL-${order.body.orderNumber},01712345678,${d},cod,"2,060.00",60,20.60,0,0,1979.40,`,
    // a parcel nobody booked: an open discrepancy
    `T9,NOT-OURS-1,,,,${d},cod,700,60,7,0,0,,`,
  ].join('\n');
  await api
    .post('/v1/settlements/import', { provider: 'steadfast', csv, fileName: 's.csv' })
    .expect(200);
  await api
    .post('/v1/finance/costs', {
      kind: 'packaging',
      amountMinor: 5_000,
      incurredOn: d,
      note: 'Boxes',
      idempotencyKey: key('cost'),
    })
    .expect(201);
  await api
    .post('/v1/members/invitations', { email: uniqueEmail('invitee'), role: 'STAFF' })
    .expect(201);
  await api.put('/v1/automation/rules/NEW_ORDER', { enabled: true }).expect(200);
  await api
    .put('/v1/notification-preferences', {
      items: [{ kind: 'NEW_ORDER', inApp: true, push: false, email: false }],
    })
    .expect(200);

  // Meta: a mock Page, a customer's message and the draft made from it
  const meta = (
    await api
      .post('/v1/integrations/meta/mock/connection', { provider: 'facebook_page' })
      .expect(201)
  ).body as { id: string };
  await api
    .post('/v1/integrations/meta/mock/events', {
      connectionId: meta.id,
      senderId: `PSID-${randomUUID().slice(0, 6)}`,
      text: 'Name: Karim Hossain\nPhone: 01898765432\nAddress: Flat 4B, Gulshan, Dhaka\n1 pcs thing',
    })
    .expect(200);
  await drain(metaQueue, (job) =>
    processSocialEvent(
      { db: t.db, log: () => undefined },
      job.data as { tenantId: string; eventId: string },
    ),
  );

  // TikTok: a mock shop with a reserved order (holds, a SKU link, an event), and one unmapped SKU left waiting
  const tiktok = (await api.post('/v1/integrations/tiktok-shop/mock/connection', {}).expect(201))
    .body as { id: string };
  await api
    .post('/v1/integrations/tiktok-shop/mock/orders', {
      connectionId: tiktok.id,
      items: [
        { skuId: 'tt-1', sellerSku: variant.sku, quantity: 2, unitPriceMinor: 1500 },
        { skuId: 'tt-unmapped', sellerSku: 'NO-SUCH-SKU', quantity: 1 },
      ],
    })
    .expect(200);
  await api
    .post('/v1/integrations/tiktok-shop/mock/orders', {
      connectionId: tiktok.id,
      items: [{ skuId: 'tt-1', sellerSku: variant.sku, quantity: 1 }],
    })
    .expect(200);

  // what only background jobs write
  await withAdmin(async (c) => {
    // a live TikTok shop (sealed token pair) and a sign-in in progress (a sealed hand-over): the schedule must delete both
    const liveShop = (
      await c.query(
        `INSERT INTO tiktok_connections (id, tenant_id, grant_id, shop_id, shop_cipher, shop_name, access_token_enc, refresh_token_enc, updated_at)
         VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, 'ROW_cipher', 'Live shop', 'v1.k1.sealed-a', 'v1.k1.sealed-r', now()) RETURNING id`,
        [tenantId, `live_${randomUUID()}`],
      )
    ).rows[0].id as string;
    void liveShop;
    await c.query(
      `INSERT INTO tiktok_oauth_sessions (id, tenant_id, user_id, state_hash, grant_enc, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'v1.k1.sealed-grant', now() + interval '10 minutes')`,
      [tenantId, owner.user.id, randomUUID()],
    );
    const rule = (
      await c.query('SELECT id FROM automation_rules WHERE tenant_id = $1 LIMIT 1', [tenantId])
    ).rows[0]?.id as string | undefined;
    const ruleId =
      rule ??
      (
        await c.query(
          `INSERT INTO automation_rules (id, tenant_id, kind, updated_at) VALUES (gen_random_uuid(), $1, 'LOW_STOCK', now()) RETURNING id`,
          [tenantId],
        )
      ).rows[0].id;
    const run = (
      await c.query(
        `INSERT INTO automation_runs (id, tenant_id, rule_id, kind, slot_key, trigger, scheduled_for)
         VALUES (gen_random_uuid(), $1, $2, 'NEW_ORDER', 'slot-1', 'event', now()) RETURNING id`,
        [tenantId, ruleId],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO automation_state (tenant_id, rule_id, subject_id, last_notified_at) VALUES ($1, $2, 'sku-1', now())`,
      [tenantId, ruleId],
    );
    const note = (
      await c.query(
        `INSERT INTO notifications (id, tenant_id, user_id, run_id, kind, title, body, dedupe_key)
         VALUES (gen_random_uuid(), $1, $2, $3, 'NEW_ORDER', 'New order', 'Order 1', 'dedupe-1') RETURNING id`,
        [tenantId, owner.user.id, run],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO notification_deliveries (id, tenant_id, notification_id, channel, updated_at) VALUES (gen_random_uuid(), $1, $2, 'in_app', now())`,
      [tenantId, note],
    );
    await c.query(
      `INSERT INTO notification_preferences (tenant_id, user_id, kind) VALUES ($1, $2, 'DAILY_REPORT') ON CONFLICT DO NOTHING`,
      [tenantId, owner.user.id],
    );
    await c.query(
      `INSERT INTO messaging_consents (id, tenant_id, user_id, channel, phone, granted_at, source)
       VALUES (gen_random_uuid(), $1, $2, 'sms', '+8801700000000', now(), 'test')`,
      [tenantId, owner.user.id],
    );
    await c.query(
      `INSERT INTO social_oauth_sessions (id, tenant_id, user_id, state_hash, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '10 minutes')`,
      [tenantId, owner.user.id, randomUUID()],
    );
    await c.query(
      `INSERT INTO discrepancies (id, tenant_id, type, subject_key, message, updated_at)
       SELECT gen_random_uuid(), $1, 'short_paid', 'item:test-1', 'A line nobody could match', now()
       WHERE NOT EXISTS (SELECT 1 FROM discrepancies WHERE tenant_id = $1)`,
      [tenantId],
    );
    await c.query(
      `INSERT INTO import_jobs (id, tenant_id, kind) VALUES (gen_random_uuid(), $1, 'products')`,
      [tenantId],
    );
  });
  return { owner, api, tenantId };
}

/** Make the grace period over (a clock we control: the row, not the wall clock). */
const endGrace = (tenantId: string) =>
  withAdmin((c) =>
    c.query(`UPDATE tenants SET purge_after = now() - interval '1 minute' WHERE id = $1`, [
      tenantId,
    ]),
  );
const tenantRow = (tenantId: string) =>
  withAdmin(
    async (c) => (await c.query('SELECT * FROM tenants WHERE id = $1', [tenantId])).rows[0],
  );

describe('who may ask, and what is checked', () => {
  it('only an owner may ask or cancel; every member may read the status', async () => {
    const owner = await registerTenant(t);
    const admin = await addMember(t, owner, 'ADMIN');
    const staff = await addMember(t, owner, 'STAFF');
    for (const who of [admin, staff]) {
      expect((await request(who, { confirmName: 'Test Shop', password: PASSWORD })).status).toBe(
        403,
      );
      expect((await call(who).post('/v1/tenant/cancel-deletion')).status).toBe(403);
      const s = await status(who).expect(200);
      expect(s.body).toMatchObject({ scheduled: false, businessName: 'Test Shop', graceDays: 14 });
    }
    expect((await t.http.get('/v1/tenant/deletion-status')).status).toBe(401);
    expect((await tenantRow(owner.tenant.id)).purge_after).toBeNull();
  });

  it('needs the exact business name and the owner’s password', async () => {
    const owner = await registerTenant(t, { tenantName: 'Exact Name Shop' });
    const wrongName = await request(owner, { confirmName: 'exact name', password: PASSWORD });
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.errors[0].path).toBe('body.confirmName');
    const wrongPassword = await request(owner, {
      confirmName: 'Exact Name Shop',
      password: 'Wrong-password-9!',
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.code).toBe('invalid_credentials');
    expect((await request(owner, { confirmName: 'Exact Name Shop' })).status).toBe(400);
    // nothing was scheduled, and the business still works
    expect((await tenantRow(owner.tenant.id)).purge_after).toBeNull();
    await call(owner).get('/v1/orders').expect(200);
  });
});

describe('the moment the owner asks', () => {
  it('blocks the business at once (403 tenant_deleted), except what is needed to cancel, look, leave or sign out', async () => {
    const owner = await registerTenant(t, { tenantName: 'Closing Shop' });
    const staff = await addMember(t, owner, 'STAFF');
    const asked = await request(owner, { confirmName: 'Closing Shop', password: PASSWORD }).expect(
      200,
    );
    expect(asked.body).toMatchObject({
      scheduled: true,
      businessName: 'Closing Shop',
      canCancel: true,
    });
    const days = (new Date(asked.body.purgeAfter).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);

    // the owner's own session stays (to reach Cancel); everyone else's is ended
    expect((await call(staff).get('/v1/me')).status).toBe(401);
    const staffAgain = (
      await t.http
        .post('/v1/auth/login')
        .send({ email: staff.email, password: PASSWORD })
        .expect(200)
    ).body as { accessToken: string };

    for (const who of [owner, staffAgain]) {
      for (const [m, p] of [
        ['get', '/v1/orders'],
        ['get', '/v1/tenant'],
        ['get', '/v1/products'],
        ['get', '/v1/dashboard'],
        ['get', '/v1/members'],
      ] as const) {
        const r = await t.http[m](p).set(bearer(who.accessToken));
        expect(
          r.status,
          `${m} ${p} ${who === owner ? 'owner' : 'staff'} ${JSON.stringify(r.body)}`,
        ).toBe(403);
        expect(r.body.code).toBe('tenant_deleted');
      }
      expect(
        (
          await t.http
            .post('/v1/customers')
            .set(bearer(who.accessToken))
            .send({ name: 'Abc Def', phone: '01711111111' })
        ).body.code,
      ).toBe('tenant_deleted');
      // what stays open
      await t.http.get('/v1/me').set(bearer(who.accessToken)).expect(200);
      await t.http.get('/v1/workspaces').set(bearer(who.accessToken)).expect(200);
      const s = await t.http
        .get('/v1/tenant/deletion-status')
        .set(bearer(who.accessToken))
        .expect(200);
      expect(s.body).toMatchObject({ scheduled: true, canCancel: who === owner });
    }
    // a member who is not the owner cannot cancel, and the guard says why before the role check
    expect(
      (await t.http.post('/v1/tenant/cancel-deletion').set(bearer(staffAgain.accessToken))).status,
    ).toBe(403);
    // they can sign out
    await t.http.post('/v1/auth/logout').set(bearer(staffAgain.accessToken)).expect(200);
  });

  it('deletes courier credentials and Meta tokens, switches automation off, revokes invitations, and tells the members', async () => {
    const shop = await fullBusiness('Credentials Shop');
    const staff = await addMember(t, shop.owner, 'MANAGER');
    const before = await withAdmin(async (c) => ({
      courier: (
        await c.query(
          'SELECT credentials_enc, webhook_secret_enc, enabled FROM courier_connections WHERE tenant_id = $1',
          [shop.tenantId],
        )
      ).rows[0],
      meta: (
        await c.query(
          'SELECT status, access_token_enc FROM social_connections WHERE tenant_id = $1',
          [shop.tenantId],
        )
      ).rows[0],
      rules: (
        await c.query(
          'SELECT count(*)::int n FROM automation_rules WHERE tenant_id = $1 AND enabled',
          [shop.tenantId],
        )
      ).rows[0].n,
    }));
    expect(before.courier.credentials_enc).toBeTruthy();
    const liveBefore = await withAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT access_token_enc FROM tiktok_connections WHERE tenant_id = $1 AND shop_id LIKE 'live\\_%'`,
            [shop.tenantId],
          )
        ).rows,
    );
    expect(liveBefore).toEqual([{ access_token_enc: 'v1.k1.sealed-a' }]);
    expect(before.courier.enabled).toBe(true);
    expect(before.rules).toBeGreaterThan(0);

    await request(shop.owner, { confirmName: 'Credentials Shop', password: PASSWORD }).expect(200);
    const after = await withAdmin(async (c) => ({
      courier: (
        await c.query(
          'SELECT credentials_enc, webhook_secret_enc, enabled FROM courier_connections WHERE tenant_id = $1',
          [shop.tenantId],
        )
      ).rows[0],
      meta: (
        await c.query(
          'SELECT status, access_token_enc FROM social_connections WHERE tenant_id = $1',
          [shop.tenantId],
        )
      ).rows[0],
      oauth: (
        await c.query('SELECT count(*)::int n FROM social_oauth_sessions WHERE tenant_id = $1', [
          shop.tenantId,
        ])
      ).rows[0].n,
      tiktok: (
        await c.query(
          `SELECT status::text AS status, access_token_enc, refresh_token_enc, shop_cipher FROM tiktok_connections WHERE tenant_id = $1 AND shop_id LIKE 'live\\_%'`,
          [shop.tenantId],
        )
      ).rows,
      tiktokSessions: (
        await c.query('SELECT count(*)::int n FROM tiktok_oauth_sessions WHERE tenant_id = $1', [
          shop.tenantId,
        ])
      ).rows[0].n,
      rules: (
        await c.query(
          'SELECT count(*)::int n FROM automation_rules WHERE tenant_id = $1 AND enabled',
          [shop.tenantId],
        )
      ).rows[0].n,
      liveInvites: (
        await c.query(
          'SELECT count(*)::int n FROM invitations WHERE tenant_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL',
          [shop.tenantId],
        )
      ).rows[0].n,
      liveSessions: (
        await c.query(
          'SELECT count(*)::int n FROM sessions WHERE active_tenant_id = $1 AND revoked_at IS NULL',
          [shop.tenantId],
        )
      ).rows[0].n,
    }));
    expect(after.courier).toEqual({
      credentials_enc: null,
      webhook_secret_enc: null,
      enabled: false,
    });
    expect(after.meta).toEqual({ status: 'disconnected', access_token_enc: null });
    expect(after.oauth).toBe(0);
    // TikTok: the sealed token pair and the cipher are gone, and so is a sign-in in progress
    expect(after.tiktok).toEqual([
      {
        status: 'disconnected',
        access_token_enc: null,
        refresh_token_enc: null,
        shop_cipher: null,
      },
    ]);
    expect(after.tiktokSessions).toBe(0);
    expect(after.rules).toBe(0);
    expect(after.liveInvites).toBe(0);
    expect(after.liveSessions).toBe(1); // the owner's, so they can cancel

    // nothing is deleted yet: the data waits for the grace period
    const counts = await withAdmin((c) => tenantRowCounts(c, shop.tenantId));
    expect(counts['orders']).toBeGreaterThan(0);
    expect(counts['customers']).toBeGreaterThan(0);

    // everyone who belonged is told, once, with the date and no business name
    const to = (email: string) => t.mail.to(email, 'tenant_deletion_scheduled');
    expect(to(shop.owner.email)).toHaveLength(1);
    expect(to(staff.email)).toHaveLength(1);
    expect(to(staff.email)[0]!.text).toMatch(/\d{4}-\d{2}-\d{2} \(UTC\)/);
    expect(to(staff.email)[0]!.text).not.toContain('Credentials Shop');

    // the request is on record, and there is no personal data in the record
    const audit = (await call(shop.owner).get('/v1/audit-logs')).body;
    expect(audit.code).toBe('tenant_deleted'); // even the audit log is closed; read it directly
    const rows = await withAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT metadata FROM audit_logs WHERE tenant_id = $1 AND action = 'tenant.deletion_requested'`,
            [shop.tenantId],
          )
        ).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ source: 'owner', graceDays: 14 });
  });

  it('asking again changes nothing: the business is already blocked, so the date stays, no second mail, no second record', async () => {
    const owner = await registerTenant(t, { tenantName: 'Twice Shop' });
    const first = await request(owner, { confirmName: 'Twice Shop', password: PASSWORD }).expect(
      200,
    );
    const mails = t.mail.to(owner.email, 'tenant_deletion_scheduled').length;
    const second = await request(owner, { confirmName: 'Twice Shop', password: PASSWORD });
    expect(second.status).toBe(403);
    expect(second.body.code).toBe('tenant_deleted');
    expect((await status(owner)).body.purgeAfter).toBe(first.body.purgeAfter);
    expect(t.mail.to(owner.email, 'tenant_deletion_scheduled')).toHaveLength(mails);
    const n = await withAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT count(*)::int n FROM audit_logs WHERE tenant_id = $1 AND action = 'tenant.deletion_requested'`,
            [owner.tenant.id],
          )
        ).rows[0].n,
    );
    expect(n).toBe(1);
  });

  it('honours TENANT_DELETION_GRACE_DAYS', async () => {
    const short = await createTestApp({ TENANT_DELETION_GRACE_DAYS: '1' });
    try {
      const owner = await registerTenant(short);
      const r = await short.http
        .post('/v1/tenant/delete-request')
        .set(bearer(owner.accessToken))
        .send({ confirmName: 'Test Shop', password: PASSWORD })
        .expect(200);
      expect(r.body.graceDays).toBe(1);
      const hours = (new Date(r.body.purgeAfter).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThanOrEqual(24);
    } finally {
      await short.close();
    }
  });
});

describe('cancelling', () => {
  it('within the grace period the business works again; what was deleted at the request is not restored', async () => {
    const shop = await fullBusiness('Cancel Shop');
    await request(shop.owner, { confirmName: 'Cancel Shop', password: PASSWORD }).expect(200);
    const cancelled = await call(shop.owner).post('/v1/tenant/cancel-deletion').expect(200);
    expect(cancelled.body).toMatchObject({ scheduled: false, purgeAfter: null, canCancel: false });
    await call(shop.owner).get('/v1/orders').expect(200);
    expect((await status(shop.owner)).body.scheduled).toBe(false);
    const row = await tenantRow(shop.tenantId);
    expect(row).toMatchObject({
      purge_after: null,
      deletion_requested_at: null,
      deletion_requested_by_id: null,
    });
    // not restored: the owner has to reconnect the courier and switch rules on again
    const courier = await withAdmin(
      async (c) =>
        (
          await c.query(
            'SELECT credentials_enc, enabled FROM courier_connections WHERE tenant_id = $1',
            [shop.tenantId],
          )
        ).rows[0],
    );
    expect(courier).toEqual({ credentials_enc: null, enabled: false });
    const actions = await withAdmin(async (c) =>
      (
        await c.query(
          `SELECT action FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'tenant.deletion%' ORDER BY created_at`,
          [shop.tenantId],
        )
      ).rows.map((r) => r.action),
    );
    expect(actions).toEqual(['tenant.deletion_requested', 'tenant.deletion_cancelled']);
    // and a purge now finds nothing to do
    expect(await t.db.tenantsDueForPurge(100)).not.toContain(shop.tenantId);
    expect((await t.db.purgeTenant(shop.tenantId)).purged).toBe(false);
    expect((await withAdmin((c) => tenantRowCounts(c, shop.tenantId)))['orders']).toBeGreaterThan(
      0,
    );
  });

  it('is refused when nothing is scheduled, and after the grace period has ended', async () => {
    const owner = await registerTenant(t);
    const none = await call(owner).post('/v1/tenant/cancel-deletion');
    expect(none.status).toBe(409);
    await request(owner, { confirmName: 'Test Shop', password: PASSWORD }).expect(200);
    await endGrace(owner.tenant.id);
    const late = await call(owner).post('/v1/tenant/cancel-deletion');
    expect(late.status).toBe(409);
    expect(late.body.detail).toMatch(/grace period has ended/);
    expect((await status(owner)).body).toMatchObject({ scheduled: true, canCancel: false });
  });
});

describe('the purge', () => {
  it('waits for the grace period, then deletes every row of the business and nothing of any other', async () => {
    const doomed = await fullBusiness('Doomed Shop');
    const bystander = await fullBusiness('Bystander Shop');
    const sameOwnerOther = await addMember(t, bystander.owner, 'STAFF');
    void sameOwnerOther;
    const bystanderBefore = await withAdmin((c) => tenantRowCounts(c, bystander.tenantId));

    // the fixture really fills every tenant table, so "zero afterwards" means something
    const before = await withAdmin((c) => tenantRowCounts(c, doomed.tenantId));
    expect(Object.keys(before).sort()).toEqual([...TENANT_TABLES].sort());
    const empty = Object.entries(before)
      .filter(([, n]) => n === 0)
      .map(([k]) => k);
    expect(empty).toEqual([]);

    await request(doomed.owner, { confirmName: 'Doomed Shop', password: PASSWORD }).expect(200);

    // inside the grace period: not due, and a purge call changes nothing
    const waiting = await withAdmin((c) => tenantRowCounts(c, doomed.tenantId));
    expect(await t.db.tenantsDueForPurge(100)).not.toContain(doomed.tenantId);
    const early = await t.db.purgeTenant(doomed.tenantId);
    expect(early).toMatchObject({ purged: false, rowsDeleted: 0 });
    expect(await withAdmin((c) => tenantRowCounts(c, doomed.tenantId))).toEqual(waiting);
    expect(waiting['orders']).toBe(before['orders']);

    // after it: due, and purged
    await endGrace(doomed.tenantId);
    expect(await t.db.tenantsDueForPurge(100)).toContain(doomed.tenantId);
    expect(await t.db.tenantsDueForPurge(100)).not.toContain(bystander.tenantId);
    const result = await t.db.purgeTenant(doomed.tenantId);
    expect(result.purged).toBe(true);
    expect(result.rowsDeleted).toBeGreaterThan(30);
    expect(result.counts['orders']).toBe(1);
    expect(Object.keys(result.counts).sort()).toEqual(
      Object.keys(result.counts)
        .sort()
        .filter((k) => (TENANT_TABLES as readonly string[]).includes(k)),
    );

    const after = await withAdmin((c) => tenantRowCounts(c, doomed.tenantId));
    for (const table of TENANT_TABLES) expect(after[table], table).toBe(0);
    expect(await tenantRow(doomed.tenantId)).toBeUndefined();

    // another business is untouched, row for row
    expect(await withAdmin((c) => tenantRowCounts(c, bystander.tenantId))).toEqual(bystanderBefore);
    await call(bystander.owner).get('/v1/orders').expect(200);

    // repeating it is harmless
    expect(await t.db.purgeTenant(doomed.tenantId)).toMatchObject({
      purged: false,
      rowsDeleted: 0,
    });
    expect(await t.db.tenantsDueForPurge(100)).not.toContain(doomed.tenantId);

    // the people: the owner had no other business, so the account is anonymised (the same as deleting it); sessions are gone
    const owner = await withAdmin(
      async (c) =>
        (
          await c.query('SELECT email, name, deleted_at, disabled_at FROM users WHERE id = $1', [
            doomed.owner.user.id,
          ])
        ).rows[0],
    );
    expect(owner.email).toBe(`deleted-${doomed.owner.user.id}@deleted.invalid`);
    expect(owner.name).toBe('Deleted user');
    expect(owner.deleted_at).not.toBeNull();
    expect((await call(doomed.owner).get('/v1/me')).status).toBe(401);
    // ... and the one line left behind holds ids and numbers only
    const left = await withAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT metadata, tenant_id FROM audit_logs WHERE action = 'tenant.purged' AND target_id = $1`,
            [doomed.tenantId],
          )
        ).rows,
    );
    expect(left).toHaveLength(1);
    expect(left[0].tenant_id).toBeNull();
    expect(Object.keys(left[0].metadata).sort()).toEqual(['rows', 'userAnonymised']);
  });

  it('does not touch a member who only belonged, nor an owner who has another business', async () => {
    const owner = await registerTenant(t, { tenantName: 'Leaving Shop' });
    const member = await addMember(t, owner, 'STAFF');
    // the owner also belongs to a second business, so their account stays
    const second = await registerTenant(t, { tenantName: 'Second Home' });
    const joined = await addMember(t, second, 'MANAGER', { email: owner.email });
    expect(joined.user.id).toBe(owner.user.id);

    await request(owner, { confirmName: 'Leaving Shop', password: PASSWORD }).expect(200);
    await endGrace(owner.tenant.id);
    expect((await t.db.purgeTenant(owner.tenant.id)).purged).toBe(true);

    const rows = await withAdmin(
      async (c) =>
        (
          await c.query('SELECT id, email, deleted_at FROM users WHERE id = ANY($1)', [
            [owner.user.id, member.user.id],
          ])
        ).rows,
    );
    for (const r of rows) {
      expect(r.deleted_at, r.id).toBeNull();
      expect(r.email).not.toMatch(/deleted\.invalid/);
    }
    // the owner can still sign in, into the business they have left; the member has nothing left to enter
    const login = await t.http
      .post('/v1/auth/login')
      .send({ email: owner.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.tenant.id).toBe(second.tenant.id);
    const orphan = await t.http
      .post('/v1/auth/login')
      .send({ email: member.email, password: PASSWORD });
    expect(orphan.status).toBe(403);
  });

  it('an account deleted while its business waited leaves a purge that still works', async () => {
    const owner = await registerTenant(t, { tenantName: 'Orphan Shop' });
    await call(owner)
      .post('/v1/customers', { name: 'Some Person', phone: '01733333333' })
      .expect(201);
    await call(owner).post('/v1/me/delete', { password: PASSWORD, confirm: 'DELETE' }).expect(200);
    await endGrace(owner.tenant.id);
    const r = await t.db.purgeTenant(owner.tenant.id);
    expect(r).toMatchObject({ purged: true, userAnonymised: false });
    expect((await withAdmin((c) => tenantRowCounts(c, owner.tenant.id)))['customers']).toBe(0);
  });
});

describe('what the runtime role can and cannot do', () => {
  it('may run the purge functions, but a business that was not asked to be deleted is refused whatever is passed', async () => {
    const live = await registerTenant(t);
    expect(await t.db.tenantsDueForPurge(100)).not.toContain(live.tenant.id);
    expect(await t.db.purgeTenant(live.tenant.id)).toMatchObject({ purged: false });
    expect(await t.db.purgeTenant(randomUUID())).toMatchObject({ purged: false });
    expect((await call(live).get('/v1/tenant')).status).toBe(200);
    expect((await withAdmin((c) => tenantRowCounts(c, live.tenant.id)))['memberships']).toBe(1);
  });

  it('can execute exactly the granted functions and not the helpers; PUBLIC can execute none of them', async () => {
    const grants = await withAdmin(
      async (c) =>
        (
          await c.query<{ proname: string; app: boolean; pub: boolean }>(
            `SELECT p.proname,
                  has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS pub
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('erase_customer','delete_own_account','tenants_due_for_purge','purge_tenant',
                               '_anonymise_user','erasure_pattern','erasure_scrub_text','erasure_scrub_json','erasure_phone_forms')`,
          )
        ).rows,
    );
    const by = Object.fromEntries(grants.map((g) => [g.proname, g]));
    for (const granted of [
      'erase_customer',
      'delete_own_account',
      'tenants_due_for_purge',
      'purge_tenant',
    ])
      expect(by[granted], granted).toMatchObject({ app: true, pub: false });
    for (const hidden of [
      '_anonymise_user',
      'erasure_pattern',
      'erasure_scrub_text',
      'erasure_scrub_json',
      'erasure_phone_forms',
    ])
      expect(by[hidden], hidden).toMatchObject({ app: false, pub: false });
    // all of them run as the migration role, with a pinned search path
    const defs = await withAdmin(
      async (c) =>
        (
          await c.query<{ proname: string; definer: boolean; owner: string; cfg: string[] | null }>(
            `SELECT p.proname, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS cfg
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('erase_customer','delete_own_account','tenants_due_for_purge','purge_tenant','_anonymise_user')`,
          )
        ).rows,
    );
    for (const d of defs) {
      expect(d.definer, d.proname).toBe(true);
      expect(d.owner, d.proname).toBe('app_migrator');
      expect(d.cfg?.join(','), d.proname).toContain('search_path=pg_catalog, public, pg_temp');
    }
  });

  it('cannot read or delete another business or any history through its own policies', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    // the runtime role still has no DELETE on the audit trail or the ledger, and no policy lets it see another business
    await expect(
      t.db.withContext({ tenantId: a.tenant.id }, (tx) => tx.auditLog.deleteMany({})),
    ).rejects.toThrow();
    const seen = await t.db.withContext({ tenantId: a.tenant.id }, (tx) =>
      tx.tenant.findMany({ select: { id: true } }),
    );
    expect(seen.map((x) => x.id)).toEqual([a.tenant.id]);
    expect(b.tenant.id).not.toBe(a.tenant.id);
  });
});
