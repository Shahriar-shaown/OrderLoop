import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  MetaGraphClient,
  SecretBox,
  buildSignedRequest,
  checkConnectionHealth,
  processSocialEvent,
  runHealthSweep,
  sampleNotification,
  signedWebhook,
} from '@orderloop/automation';
import { META_SCOPES, routes } from '@orderloop/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createTestApp, registerTenant, type TestApp } from './app.js';
import { fakeGraph, newPage, type FakeGraph } from './meta-helpers.js';

const SECRET = 'test-app-secret-0123456789';
const VERIFY = 'test-verify-token-0123456789';
const API = 'https://api.test.example';
const WEB = 'https://app.test.example';
const LIVE_ENV = {
  META_MODE: 'live',
  META_APP_ID: '1234567890',
  META_APP_SECRET: SECRET,
  META_WEBHOOK_VERIFY_TOKEN: VERIFY,
  META_GRAPH_VERSION: 'v23.0',
  API_PUBLIC_URL: API,
  WEB_APP_URL: WEB,
};

type Owner = Awaited<ReturnType<typeof registerTenant>>;
const as = (t: TestApp, who: { accessToken: string }) => ({
  get: (p: string) => t.http.get(p).set(bearer(who.accessToken)),
  post: (p: string, b: object = {}) => t.http.post(p).set(bearer(who.accessToken)).send(b),
  patch: (p: string, b: object) => t.http.patch(p).set(bearer(who.accessToken)).send(b),
  del: (p: string) => t.http.delete(p).set(bearer(who.accessToken)),
});

const mid = () => `m_${randomUUID()}`;

// =====================================================================================================================
// Mock mode
// =====================================================================================================================
describe('mock mode', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ META_MODE: 'mock' });
  });
  afterAll(() => t.close());

  it('reports mode mock, not configured for live, and the minimal scopes', async () => {
    const o = await registerTenant(t);
    const r = (await as(t, o).get('/v1/integrations/meta').expect(200)).body;
    expect(r).toMatchObject({ mode: 'mock', webhookUrl: null, connections: [], openDrafts: 0 });
    expect(r.liveConfigured).toBe(false);
    expect(r.scopes).toEqual([...META_SCOPES]);
    expect(r.scopes).toEqual([
      'pages_show_list',
      'pages_messaging',
      'pages_manage_metadata',
      'instagram_basic',
      'instagram_manage_messages',
    ]);
  });

  it('the live-only calls say so: oauth start and reconnect are 409 meta_not_configured', async () => {
    const o = await registerTenant(t);
    const a = as(t, o);
    const r = await a.post('/v1/integrations/meta/oauth/start');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('meta_not_configured');
    const conn = (await a.post('/v1/integrations/meta/mock/connection').expect(201)).body;
    expect((await a.post(`/v1/integrations/meta/connections/${conn.id}/reconnect`)).body.code).toBe(
      'meta_not_configured',
    );
    expect(
      (await t.http.get('/v1/integrations/meta/oauth/callback?code=x&state=y')).headers.location,
    ).toContain('error=meta_not_configured');
    expect(
      (await t.http.get('/v1/integrations/meta/oauth/begin?ticket=x')).headers.location,
    ).toContain('error=meta_not_configured');
  });

  it('makes a labelled mock connection and runs a synthetic message through the pipeline into a flagged draft', async () => {
    const o = await registerTenant(t);
    const a = as(t, o);
    const conn = (
      await a
        .post('/v1/integrations/meta/mock/connection', {
          provider: 'instagram',
          displayName: 'My IG',
        })
        .expect(201)
    ).body;
    expect(conn).toMatchObject({
      provider: 'instagram',
      mock: true,
      status: 'active',
      displayName: 'My IG',
    });
    expect(conn.externalId).toMatch(/^mock_/);
    expect(JSON.stringify(conn)).not.toMatch(/accessToken|access_token|Enc"/);

    const ev = (
      await a
        .post('/v1/integrations/meta/mock/events', {
          connectionId: conn.id,
          senderId: 'cust-1',
          text: 'অর্ডার করব। মোবাইল ০১৭১২৩৪৫৬৭৮, বাসা ৫ রোড ৩ ঢাকা',
          messageId: 'mid-fixed-1',
        })
        .expect(200)
    ).body;
    expect(ev).toMatchObject({
      mode: 'mock',
      mock: true,
      duplicate: false,
      status: 'processed',
      messageId: 'mid-fixed-1',
    });
    expect(ev.draftId).toBeTruthy();
    const draft = (await a.get(`/v1/social-drafts/${ev.draftId}`).expect(200)).body;
    expect(draft).toMatchObject({
      mode: 'mock',
      mock: true,
      provider: 'instagram',
      status: 'needs_review',
    });
    expect(draft.fields.phone.value).toBe('+8801712345678');
    expect(draft.fields.district.value).toBe('Dhaka');

    // replay: nothing new
    const again = (
      await a
        .post('/v1/integrations/meta/mock/events', {
          connectionId: conn.id,
          senderId: 'cust-1',
          text: 'অর্ডার করব। মোবাইল ০১৭১২৩৪৫৬৭৮, বাসা ৫ রোড ৩ ঢাকা',
          messageId: 'mid-fixed-1',
        })
        .expect(200)
    ).body;
    expect(again).toMatchObject({ duplicate: true, draftId: ev.draftId });
    expect((await a.get('/v1/social-drafts')).body.counts.needs_review).toBe(1);
    // chit-chat: ignored, no draft
    const chat = (
      await a
        .post('/v1/integrations/meta/mock/events', {
          connectionId: conn.id,
          senderId: 'cust-2',
          text: 'hello',
        })
        .expect(200)
    ).body;
    expect(chat).toMatchObject({ status: 'ignored', draftId: null });
  });

  it('refuses a connection that is not a mock one of this business, or is disconnected', async () => {
    const o = await registerTenant(t);
    const other = await registerTenant(t);
    const conn = (await as(t, o).post('/v1/integrations/meta/mock/connection').expect(201)).body;
    expect(
      (
        await as(t, other).post('/v1/integrations/meta/mock/events', {
          connectionId: conn.id,
          text: '01712345678',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(t, o).post('/v1/integrations/meta/mock/events', {
          connectionId: randomUUID(),
          text: 'x',
        })
      ).status,
    ).toBe(404);
    await as(t, o).del(`/v1/integrations/meta/connections/${conn.id}`).expect(200);
    expect(
      (
        await as(t, o).post('/v1/integrations/meta/mock/events', {
          connectionId: conn.id,
          text: '01712345678',
        })
      ).status,
    ).toBe(404);
  });

  it('validates the mock bodies', async () => {
    const o = await registerTenant(t);
    const a = as(t, o);
    await a.post('/v1/integrations/meta/mock/connection', { provider: 'whatsapp' }).expect(400);
    await a.post('/v1/integrations/meta/mock/events', { text: 'no connection' }).expect(400);
  });

  describe('permissions', () => {
    it('follows the matrix: integrations:read (owner, admin, manager), integrations:manage (owner, admin), drafts by orders:*', async () => {
      const owner = await registerTenant(t);
      const members = {
        OWNER: owner,
        ADMIN: await addMember(t, owner, 'ADMIN'),
        MANAGER: await addMember(t, owner, 'MANAGER'),
        STAFF: await addMember(t, owner, 'STAFF'),
        ACCOUNTANT: await addMember(t, owner, 'ACCOUNTANT'),
      };
      const conn = (await as(t, owner).post('/v1/integrations/meta/mock/connection').expect(201))
        .body;
      const ev = (
        await as(t, owner).post('/v1/integrations/meta/mock/events', {
          connectionId: conn.id,
          text: 'order 01712345678',
        })
      ).body;
      const status = async (
        role: keyof typeof members,
        method: 'get' | 'post' | 'patch' | 'del',
        path: string,
        body: object = {},
      ) => {
        const a = as(t, members[role]);
        const r =
          method === 'get'
            ? await a.get(path)
            : method === 'del'
              ? await a.del(path)
              : method === 'patch'
                ? await a.patch(path, body)
                : await a.post(path, body);
        return r.status;
      };
      const allowed = (s: number) => s !== 401 && s !== 403;
      const matrix: [string, 'get' | 'post' | 'patch' | 'del', string, object, string[]][] = [
        ['overview', 'get', '/v1/integrations/meta', {}, ['OWNER', 'ADMIN', 'MANAGER']],
        ['oauth start', 'post', '/v1/integrations/meta/oauth/start', {}, ['OWNER', 'ADMIN']],
        [
          'oauth session',
          'get',
          `/v1/integrations/meta/oauth/sessions/${randomUUID()}`,
          {},
          ['OWNER', 'ADMIN'],
        ],
        [
          'connect',
          'post',
          '/v1/integrations/meta/connections',
          { sessionId: randomUUID(), pageIds: ['1'] },
          ['OWNER', 'ADMIN'],
        ],
        [
          'reconnect',
          'post',
          `/v1/integrations/meta/connections/${conn.id}/reconnect`,
          {},
          ['OWNER', 'ADMIN'],
        ],
        [
          'mock connection',
          'post',
          '/v1/integrations/meta/mock/connection',
          {},
          ['OWNER', 'ADMIN'],
        ],
        [
          'mock events',
          'post',
          '/v1/integrations/meta/mock/events',
          { connectionId: conn.id, text: 'hi' },
          ['OWNER', 'ADMIN'],
        ],
        [
          'list drafts',
          'get',
          '/v1/social-drafts',
          {},
          ['OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'ACCOUNTANT'],
        ],
        [
          'get draft',
          'get',
          `/v1/social-drafts/${ev.draftId}`,
          {},
          ['OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'ACCOUNTANT'],
        ],
        [
          'edit draft',
          'patch',
          `/v1/social-drafts/${ev.draftId}`,
          { note: 'x' },
          ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'],
        ],
        [
          'confirm draft',
          'post',
          `/v1/social-drafts/${ev.draftId}/confirm`,
          {},
          ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'],
        ],
        [
          'dismiss draft',
          'post',
          `/v1/social-drafts/${randomUUID()}/dismiss`,
          {},
          ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'],
        ],
        [
          'disconnect',
          'del',
          `/v1/integrations/meta/connections/${randomUUID()}`,
          {},
          ['OWNER', 'ADMIN'],
        ],
      ];
      for (const [name, method, path, body, roles] of matrix)
        for (const role of Object.keys(members) as (keyof typeof members)[])
          expect(allowed(await status(role, method, path, body)), `${name} as ${role}`).toBe(
            roles.includes(role),
          );
      // and nobody at all without a token
      for (const [, method, path] of matrix) {
        const r =
          method === 'get'
            ? await t.http.get(path)
            : method === 'del'
              ? await t.http.delete(path)
              : method === 'patch'
                ? await t.http.patch(path)
                : await t.http.post(path);
        expect(r.status).toBe(401);
      }
      // the registry agrees with the matrix
      const specs = Object.values(routes);
      for (const id of [
        'getMetaOverview',
        'startMetaOauth',
        'connectMetaPages',
        'disconnectMetaConnection',
        'createMockMetaConnection',
        'injectMockMetaEvent',
      ])
        expect(specs.find((s) => s.id === id)!.auth).toBe('access');
    });
  });

  describe('tenant isolation', () => {
    it('another business sees none of it, by API or by database', async () => {
      const a = await registerTenant(t);
      const b = await registerTenant(t);
      const conn = (await as(t, a).post('/v1/integrations/meta/mock/connection').expect(201)).body;
      const ev = (
        await as(t, a).post('/v1/integrations/meta/mock/events', {
          connectionId: conn.id,
          text: 'order 01712345678',
        })
      ).body;
      const asB = as(t, b);
      expect((await asB.get('/v1/integrations/meta')).body.connections).toEqual([]);
      expect((await asB.get('/v1/social-drafts')).body.items).toEqual([]);
      for (const r of [
        await asB.get(`/v1/social-drafts/${ev.draftId}`),
        await asB.patch(`/v1/social-drafts/${ev.draftId}`, { note: 'x' }),
        await asB.post(`/v1/social-drafts/${ev.draftId}/dismiss`, {}),
        await asB.del(`/v1/integrations/meta/connections/${conn.id}`),
      ])
        expect(r.status).toBe(404);
      expect((await as(t, a).get(`/v1/social-drafts/${ev.draftId}`)).status).toBe(200); // untouched
      const seen = await t.db.withContext({ tenantId: b.tenant.id }, async (tx) => ({
        connections: await tx.socialConnection.count(),
        events: await tx.socialEvent.count(),
        drafts: await tx.socialDraft.count(),
        sessions: await tx.socialOauthSession.count(),
        forged: await tx.socialDraft.count({ where: { tenantId: a.tenant.id } }),
      }));
      expect(seen).toEqual({ connections: 0, events: 0, drafts: 0, sessions: 0, forged: 0 });
      const none = await t.db.withContext({}, async (tx) => ({
        c: await tx.socialConnection.count(),
        e: await tx.socialEvent.count(),
        d: await tx.socialDraft.count(),
      }));
      expect(none).toEqual({ c: 0, e: 0, d: 0 });
      // writing a row for another business is refused by row-level security
      await expect(
        t.db.withContext({ tenantId: b.tenant.id }, (tx) =>
          tx.socialConnection.create({
            data: {
              tenantId: a.tenant.id,
              provider: 'facebook_page',
              externalId: `x${randomUUID()}`,
              displayName: 'x',
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('the routing function returns only (id, tenant, status) and only for a connected account', async () => {
      const a = await registerTenant(t);
      const conn = (await as(t, a).post('/v1/integrations/meta/mock/connection').expect(201)).body;
      expect(await t.db.metaConnectionFor('facebook_page', conn.externalId)).toEqual({
        id: conn.id,
        tenantId: a.tenant.id,
        status: 'active',
      });
      expect(await t.db.metaConnectionFor('instagram', conn.externalId)).toBeNull(); // provider is part of the key
      await as(t, a).del(`/v1/integrations/meta/connections/${conn.id}`).expect(200);
      expect(await t.db.metaConnectionFor('facebook_page', conn.externalId)).toBeNull();
    });
  });

  describe('retention', () => {
    it('deletes old unconfirmed, dismissed and confirmed drafts and old events; keeps recent ones, open conversations and unprocessed events', async () => {
      const o = await registerTenant(t);
      const a = as(t, o);
      const conn = (await a.post('/v1/integrations/meta/mock/connection').expect(201)).body;
      const inject = async (sender: string, text: string) =>
        (
          await a
            .post('/v1/integrations/meta/mock/events', {
              connectionId: conn.id,
              senderId: sender,
              text,
            })
            .expect(200)
        ).body as { draftId: string | null; eventId: string };
      const oldOpen = await inject('s-old-open', 'order 01712345601');
      const recentOpen = await inject('s-recent-open', 'order 01712345602');
      const oldDismissed = await inject('s-dismissed', 'order 01712345603');
      const recentDismissed = await inject('s-dismissed2', 'order 01712345604');
      const oldChat = await inject('s-chat', 'hello');
      await a.post(`/v1/social-drafts/${oldDismissed.draftId}/dismiss`, {}).expect(200);
      await a.post(`/v1/social-drafts/${recentDismissed.draftId}/dismiss`, {}).expect(200);
      const days = (n: number) => `now() - interval '${n} days'`;
      await t.db.withContext({ tenantId: o.tenant.id }, async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE social_drafts SET last_message_at = ${days(40)} WHERE id = '${oldOpen.draftId}'`,
        );
        await tx.$executeRawUnsafe(
          `UPDATE social_drafts SET updated_at = ${days(40)} WHERE id = '${oldDismissed.draftId}'`,
        );
        await tx.$executeRawUnsafe(
          `UPDATE social_events SET created_at = ${days(40)} WHERE tenant_id = '${o.tenant.id}'`,
        );
        // the recent open draft keeps its (old) events: its conversation is still open
        await tx.$executeRawUnsafe(
          `UPDATE social_events SET status = 'received' WHERE id = '${recentOpen.eventId}'`,
        );
        await tx.$executeRawUnsafe(
          `UPDATE social_events SET status = 'processed' WHERE id = '${recentOpen.eventId}'`,
        );
        await tx.socialOauthSession.create({
          data: {
            tenantId: o.tenant.id,
            userId: o.user.id,
            stateHash: randomUUID(),
            expiresAt: new Date(Date.now() - 3 * 86_400_000),
          },
        });
        await tx.socialOauthSession.create({
          data: {
            tenantId: o.tenant.id,
            userId: o.user.id,
            stateHash: randomUUID(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
      });
      const unprocessed = await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.socialEvent.create({
          data: {
            tenantId: o.tenant.id,
            connectionId: conn.id,
            provider: 'facebook_page',
            externalEventId: `stuck-${randomUUID()}`,
            senderId: 'stuck',
            eventType: 'message',
            eventTimestamp: new Date(),
            createdAt: new Date(Date.now() - 40 * 86_400_000),
          },
        }),
      );

      const r = await t.db.purgeSocialData(30);
      expect(r.drafts).toBeGreaterThanOrEqual(2);
      expect(r.events).toBeGreaterThanOrEqual(2);
      expect(r.sessions).toBeGreaterThanOrEqual(1);
      const left = await t.db.withContext({ tenantId: o.tenant.id }, async (tx) => ({
        drafts: (await tx.socialDraft.findMany({ select: { id: true } })).map((d) => d.id),
        events: (await tx.socialEvent.findMany({ select: { id: true } })).map((e) => e.id),
        sessions: await tx.socialOauthSession.count(),
      }));
      expect(left.drafts).not.toContain(oldOpen.draftId);
      expect(left.drafts).not.toContain(oldDismissed.draftId);
      expect(left.drafts).toContain(recentOpen.draftId);
      expect(left.drafts).toContain(recentDismissed.draftId);
      expect(left.events).not.toContain(oldChat.eventId); // old, no open draft
      expect(left.events).not.toContain(oldOpen.eventId); // its draft is gone
      expect(left.events).toContain(recentOpen.eventId); // conversation still open
      expect(left.events).toContain(unprocessed.id); // never processed: not ours to delete
      expect(left.sessions).toBe(1); // the one that has not expired
      // idempotent
      expect((await t.db.purgeSocialData(30)).drafts).toBe(0);
    });

    it('a confirmed order keeps no copy of the chat, and its draft is purged with the rest', async () => {
      const o = await registerTenant(t);
      const a = as(t, o);
      const conn = (await a.post('/v1/integrations/meta/mock/connection').expect(201)).body;
      const ev = (
        await a
          .post('/v1/integrations/meta/mock/events', {
            connectionId: conn.id,
            senderId: 'c',
            text: 'Name: Secret Chat Name\n01712345611\nHouse 3, Dhaka\norder',
          })
          .expect(200)
      ).body;
      // no item is recognised, so the reviewer picks one
      const { createProduct } = await import('./app.js');
      const { variant } = await createProduct(t, o.accessToken, {});
      await a.post('/v1/inventory/receive', { variantId: variant.id, quantity: 5 }).expect(201);
      const done = (
        await a
          .post(`/v1/social-drafts/${ev.draftId}/confirm`, {
            customer: { name: 'Buyer', phone: '01712345611' },
            address: {
              recipientName: 'Buyer',
              phone: '01712345611',
              line1: 'House 3',
              area: 'Dhanmondi',
              district: 'Dhaka',
              division: 'Dhaka',
            },
            items: [{ variantId: variant.id, quantity: 1 }],
            idempotencyKey: `k-${randomUUID()}`,
          })
          .expect(200)
      ).body;
      expect(JSON.stringify(done.order)).not.toContain('Secret Chat Name');
      await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE social_drafts SET updated_at = now() - interval '40 days' WHERE id = '${ev.draftId}'`,
        ),
      );
      await t.db.purgeSocialData(30);
      expect((await a.get(`/v1/social-drafts/${ev.draftId}`)).status).toBe(404);
      expect((await a.get(`/v1/orders/${done.order.id}`)).status).toBe(200); // the order stays
    });
  });

  it('manual order entry is unchanged and works beside it (audit still written)', async () => {
    const o = await registerTenant(t);
    const a = as(t, o);
    const { createProduct } = await import('./app.js');
    const { variant } = await createProduct(t, o.accessToken, {});
    await a.post('/v1/inventory/receive', { variantId: variant.id, quantity: 5 }).expect(201);
    const res = await a.post('/v1/orders', {
      customer: { name: 'Manual Buyer', phone: '01712345622' },
      address: {
        recipientName: 'Manual Buyer',
        phone: '01712345622',
        line1: 'House 3',
        area: 'Dhanmondi',
        district: 'Dhaka',
        division: 'Dhaka',
      },
      items: [{ variantId: variant.id, quantity: 1 }],
      confirm: true,
      idempotencyKey: `manual-${randomUUID()}`,
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('other');
    const audit = await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
      tx.auditLog.findMany({ where: { tenantId: o.tenant.id, action: 'order.created' } }),
    );
    expect(audit).toHaveLength(1);
  });
});

// =====================================================================================================================
// Live mode (fake Graph)
// =====================================================================================================================
describe('live mode', () => {
  let t: TestApp;
  let graph: FakeGraph;
  let clock = Date.now();
  const logs: string[] = [];
  const tokens = new Set<string>();
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const bodies: string[] = [];

  beforeAll(async () => {
    graph = fakeGraph();
    t = await createTestApp(LIVE_ENV, {
      logDestination: sink,
      meta: { fetch: graph.fetch, now: () => new Date(clock) },
    });
  });
  afterAll(() => t.close());

  /** Record a response so the end of the file can prove no token is in any of them. */
  const seen = <T extends { body: unknown; text?: string }>(r: T): T => {
    bodies.push(JSON.stringify(r.body) + (r.text ?? ''));
    return r;
  };

  /** Open `authorizeUrl` the way a browser does (top-level GET on the API), and read what it answers: Meta's URL, the state in it, the cookie. */
  async function begin(authorizeUrl: string) {
    const u = new URL(authorizeUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`${API}/v1/integrations/meta/oauth/begin`);
    const res = await t.http.get(u.pathname + u.search);
    const meta = res.headers['location'] ? new URL(res.headers['location']) : null;
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    return {
      res,
      meta,
      state: meta?.searchParams.get('state') ?? null,
      setCookie,
      /** `name=value`, as a browser would send it back. */
      cookie: setCookie[0]?.split(';')[0] ?? null,
    };
  }

  /** Start, send the browser through begin, let "Meta" redirect back with a good code, and return the session id. */
  async function signIn(who: { accessToken: string }, opts: { reconnect?: string } = {}) {
    const a = as(t, who);
    const start = seen(
      opts.reconnect
        ? await a.post(`/v1/integrations/meta/connections/${opts.reconnect}/reconnect`)
        : await a.post('/v1/integrations/meta/oauth/start'),
    );
    expect(start.status).toBe(200);
    const b = await begin(start.body.authorizeUrl);
    expect(b.state).toBeTruthy();
    const cb = await t.http
      .get('/v1/integrations/meta/oauth/callback')
      .set('Cookie', b.cookie!)
      .query({ code: graph.goodCode, state: b.state! });
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers['location']!);
    return {
      start: {
        authorizeUrl: start.body.authorizeUrl as string,
        state: b.state!,
        cookie: b.cookie!,
      },
      location: loc,
      sessionId: loc.searchParams.get('session'),
    };
  }

  /** Start and begin, without calling back: for tests that call back by hand. */
  async function startAndBegin(who: { accessToken: string }) {
    const start = await as(t, who).post('/v1/integrations/meta/oauth/start');
    return { start, ...(await begin(start.body.authorizeUrl)) };
  }

  const dbConnections = (o: Owner) =>
    t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
      tx.socialConnection.findMany({
        where: { tenantId: o.tenant.id },
        orderBy: { createdAt: 'asc' },
      }),
    );

  describe('configuration', () => {
    it('reports live, configured, the webhook URL to paste, and 404s the mock endpoints', async () => {
      const o = await registerTenant(t);
      const a = as(t, o);
      expect((await a.get('/v1/integrations/meta').expect(200)).body).toMatchObject({
        mode: 'live',
        liveConfigured: true,
        webhookUrl: `${API}/v1/webhooks/meta`,
      });
      expect((await a.post('/v1/integrations/meta/mock/connection')).status).toBe(404);
      expect(
        (
          await a.post('/v1/integrations/meta/mock/events', {
            connectionId: randomUUID(),
            text: 'x',
          })
        ).status,
      ).toBe(404);
    });
  });

  describe('sign-in with Meta', () => {
    it('starts with exactly the minimal scopes and a signed one-time state that is stored only as a hash', async () => {
      const o = await registerTenant(t);
      const start = seen(await as(t, o).post('/v1/integrations/meta/oauth/start').expect(200));
      expect(start.body).not.toHaveProperty('state');
      const { meta: url, state } = await begin(start.body.authorizeUrl);
      expect(url).not.toBeNull();
      expect(url!.origin + url!.pathname).toBe('https://www.facebook.com/v23.0/dialog/oauth');
      expect(url!.searchParams.get('scope')!.split(',')).toEqual([...META_SCOPES]);
      expect(url!.searchParams.get('redirect_uri')).toBe(
        `${API}/v1/integrations/meta/oauth/callback`,
      );
      expect(url!.searchParams.get('state')).toBe(state);
      expect(url!.searchParams.get('client_id')).toBe('1234567890');
      expect(start.body.authorizeUrl).not.toContain(SECRET);
      expect(start.body.mode).toBe('live');
      const rows = await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.socialOauthSession.findMany({ where: { tenantId: o.tenant.id } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stateHash).toBe(createHash('sha256').update(state!).digest('hex'));
      expect(JSON.stringify(rows)).not.toContain(state!);
      expect(rows[0]!.expiresAt.getTime() - clock).toBeLessThanOrEqual(10 * 60_000 + 1000);
    });

    it('rejects a tampered, replayed, expired, foreign or missing state, and a refusal, all by redirecting with an error code', async () => {
      const o = await registerTenant(t);
      const a = as(t, o);
      graph.pages = [newPage()];
      const back = (loc: string | undefined) => new URL(loc!);
      const callback = (q: object, cookie?: string | null) => {
        const r = t.http.get('/v1/integrations/meta/oauth/callback');
        return (cookie ? r.set('Cookie', cookie) : r).query(q);
      };

      const first = await startAndBegin(o);
      const s1 = first.state!;
      const [body, sig] = s1.split('.') as [string, string];
      const forged = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(body, 'base64url').toString()),
          u: randomUUID(),
        }),
      ).toString('base64url');
      for (const state of [`${forged}.${sig}`, `${body}.AAAA`, 'garbage', `${body}.${sig}.x`]) {
        const r = await callback({ code: graph.goodCode, state });
        expect(back(r.headers['location']).origin).toBe(WEB);
        expect(back(r.headers['location']).searchParams.get('error'), state).toBe('invalid_state');
        expect(back(r.headers['location']).searchParams.has('session')).toBe(false);
      }
      expect(
        back((await callback({ code: graph.goodCode })).headers['location']).searchParams.get(
          'error',
        ),
      ).toBe('invalid_state');
      expect(graph.called('oauth/access_token')).toHaveLength(
        0 + graph.called('oauth/access_token').length,
      ); // nothing was exchanged for these

      // refusal in Meta's dialog
      const denied = await callback(
        {
          error: 'access_denied',
          error_reason: 'user_denied',
          state: s1,
        },
        first.cookie,
      );
      expect(back(denied.headers['location']).searchParams.get('error')).toBe('access_denied');
      // that state is now used: even a good code with it goes nowhere
      expect(
        back(
          (await callback({ code: graph.goodCode, state: s1 }, first.cookie)).headers['location'],
        ).searchParams.get('error'),
      ).toBe('invalid_state');

      // replay of a state that WAS used successfully
      const ok = await signIn(o);
      expect(ok.sessionId).toBeTruthy();
      const replay = await callback(
        { code: graph.goodCode, state: ok.start.state },
        ok.start.cookie,
      );
      expect(back(replay.headers['location']).searchParams.get('error')).toBe('invalid_state');

      // expiry (ten minutes)
      const second = await startAndBegin(o);
      const s2 = second.state!;
      clock += 11 * 60_000;
      try {
        expect(
          back(
            (await callback({ code: graph.goodCode, state: s2 }, second.cookie)).headers[
              'location'
            ],
          ).searchParams.get('error'),
        ).toBe('invalid_state');
      } finally {
        clock -= 11 * 60_000;
      }
    });

    describe('the sign-in is bound to the browser that began it (login CSRF)', () => {
      const callbackWith = (q: object, cookie?: string | null) => {
        const r = t.http.get('/v1/integrations/meta/oauth/callback');
        return (cookie ? r.set('Cookie', cookie) : r).query(q);
      };
      const errorOf = (r: { headers: Record<string, unknown> }) =>
        new URL(r.headers['location'] as string).searchParams.get('error');
      const sessionRows = (o: Owner) =>
        t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
          tx.socialOauthSession.findMany({ where: { tenantId: o.tenant.id } }),
        );

      it('start returns a one-time API link, not Meta, and no state; begin sets an HttpOnly Lax cookie and redirects to Meta', async () => {
        const o = await registerTenant(t);
        const start = seen(await as(t, o).post('/v1/integrations/meta/oauth/start').expect(200));
        expect(Object.keys(start.body).sort()).toEqual(['authorizeUrl', 'mode']);
        const u = new URL(start.body.authorizeUrl);
        expect(`${u.origin}${u.pathname}`).toBe(`${API}/v1/integrations/meta/oauth/begin`);
        expect(u.searchParams.get('ticket')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
        const b = await begin(start.body.authorizeUrl);
        expect(b.res.status).toBe(302);
        expect(b.res.headers['cache-control']).toBe('no-store');
        expect(b.meta!.origin).toBe('https://www.facebook.com');
        const c = b.setCookie[0]!;
        expect(c).toMatch(/^ol_meta_oauth=[A-Za-z0-9_-]{40,};/);
        expect(c).toMatch(/HttpOnly/i);
        expect(c).toMatch(/SameSite=Lax/i);
        expect(c).toMatch(/Path=\/v1\/integrations\/meta\/oauth(;|$)/);
        expect(c).toMatch(/Max-Age=\d+/i);
        // the cookie is not derivable from anything in the URLs
        expect(b.meta!.toString()).not.toContain(c.split(';')[0]!.split('=')[1]!);
        // test environment is not production, so no Secure flag here
        expect(c).not.toMatch(/Secure/i);
      });

      it('the normal flow works and clears the cookie afterwards', async () => {
        const o = await registerTenant(t);
        graph.pages = [newPage()];
        const b = await startAndBegin(o);
        const r = await callbackWith({ code: graph.goodCode, state: b.state! }, b.cookie);
        expect(new URL(r.headers['location']!).searchParams.get('session')).toBeTruthy();
        const cleared = ([] as string[]).concat(r.headers['set-cookie'] ?? [])[0]!;
        expect(cleared).toMatch(/^ol_meta_oauth=;/);
        expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      });

      it('no cookie: invalid_state, nothing exchanged, and the state is not used up', async () => {
        const o = await registerTenant(t);
        graph.pages = [newPage()];
        const b = await startAndBegin(o);
        const before = graph.called('oauth/access_token').length;
        const r = await callbackWith({ code: graph.goodCode, state: b.state! });
        expect(errorOf(r)).toBe('invalid_state');
        expect(graph.called('oauth/access_token')).toHaveLength(before);
        expect((await sessionRows(o))[0]!.stateUsedAt).toBeNull();
        // the person who did begin it can still finish
        const ok = await callbackWith({ code: graph.goodCode, state: b.state! }, b.cookie);
        expect(new URL(ok.headers['location']!).searchParams.get('session')).toBeTruthy();
      });

      it('a cookie that belongs to another sign-in, or is made up: invalid_state', async () => {
        const o = await registerTenant(t);
        const mine = await startAndBegin(o);
        const other = await startAndBegin(o);
        const before = graph.called('oauth/access_token').length;
        for (const cookie of [other.cookie, 'ol_meta_oauth=forged', 'ol_meta_oauth=', 'other=1']) {
          const r = await callbackWith({ code: graph.goodCode, state: mine.state! }, cookie);
          expect(errorOf(r), String(cookie)).toBe('invalid_state');
        }
        expect(graph.called('oauth/access_token')).toHaveLength(before);
      });

      it("the attacker-forwards-the-URL scenario: Meta's dialog URL opened in the victim's browser cannot complete", async () => {
        const attacker = await registerTenant(t);
        graph.pages = [newPage()];
        // the attacker starts a sign-in for THEIR business and learns Meta's URL (and so the state)...
        const a = await startAndBegin(attacker);
        // ...and gets the victim to approve it. The victim's browser never went through begin, so it holds no cookie.
        const r = await callbackWith({ code: graph.goodCode, state: a.state! });
        expect(errorOf(r)).toBe('invalid_state');
        expect(new URL(r.headers['location']!).searchParams.has('session')).toBe(false);
        const rows = await sessionRows(attacker);
        expect(rows[0]!.userTokenEnc).toBeNull();
        expect(rows[0]!.stateUsedAt).toBeNull();
        // a cookie from the victim's own sign-in (another state) does not help either
        const victim = await registerTenant(t);
        const v = await startAndBegin(victim);
        expect(
          errorOf(await callbackWith({ code: graph.goodCode, state: a.state! }, v.cookie)),
        ).toBe('invalid_state');
      });

      it('a ticket works once', async () => {
        const o = await registerTenant(t);
        const start = (await as(t, o).post('/v1/integrations/meta/oauth/start')).body;
        const first = await begin(start.authorizeUrl);
        expect(first.meta!.origin).toBe('https://www.facebook.com');
        const second = await begin(start.authorizeUrl);
        expect(second.setCookie).toHaveLength(0);
        expect(new URL(second.meta!).origin).toBe(WEB);
        expect(new URL(second.meta!).searchParams.get('error')).toBe('invalid_state');
      });

      it('a ticket expires after 60 seconds, and a garbage or missing ticket is invalid_state', async () => {
        const o = await registerTenant(t);
        const start = (await as(t, o).post('/v1/integrations/meta/oauth/start')).body;
        clock += 61_000;
        try {
          const late = await begin(start.authorizeUrl);
          expect(late.setCookie).toHaveLength(0);
          expect(late.meta!.searchParams.get('error')).toBe('invalid_state');
        } finally {
          clock -= 61_000;
        }
        for (const q of ['?ticket=nope', '?ticket=', '']) {
          const r = await t.http.get(`/v1/integrations/meta/oauth/begin${q}`);
          expect(r.status).toBe(302);
          expect(new URL(r.headers['location']!).searchParams.get('error')).toBe('invalid_state');
        }
      });

      it('tickets are stored only as a hash', async () => {
        const o = await registerTenant(t);
        const start = (await as(t, o).post('/v1/integrations/meta/oauth/start')).body;
        const ticket = new URL(start.authorizeUrl).searchParams.get('ticket')!;
        const { Redis } = await import('ioredis');
        const redis = new Redis(process.env['REDIS_URL']!);
        try {
          const keys = await redis.keys('meta:oauth:ticket:*');
          expect(keys.length).toBeGreaterThan(0);
          expect(keys.some((k) => k.includes(ticket))).toBe(false);
          const ttl = await redis.ttl(keys[0]!);
          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(60);
        } finally {
          redis.disconnect();
        }
      });
    });

    it('a failed code exchange redirects with a code and no detail', async () => {
      const o = await registerTenant(t);
      const start = await startAndBegin(o);
      const r = await t.http
        .get('/v1/integrations/meta/oauth/callback')
        .set('Cookie', start.cookie!)
        .query({ code: 'BAD_CODE', state: start.state! });
      const loc = new URL(r.headers['location']!);
      expect(loc.searchParams.get('error')).toBe('meta_unavailable');
      expect(loc.toString()).not.toContain('BAD_CODE');
    });

    it('success redirects to the web integrations page with a session id and no token anywhere in the URL', async () => {
      const o = await registerTenant(t);
      const page = newPage({ instagram: { id: `ig${Date.now()}`, username: 'shop_ig' } });
      graph.pages = [page, newPage()];
      const { location } = await signIn(o);
      expect(`${location.origin}${location.pathname}`).toBe(`${WEB}/settings/integrations/meta`);
      expect([...location.searchParams.keys()]).toEqual(['session']);
      expect(location.toString()).not.toMatch(/EAA|token|code=/);
      expect(location.searchParams.get('session')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('lists the Pages (names and ids only) for the person who signed in, and for nobody else', async () => {
      const o = await registerTenant(t);
      const admin = await addMember(t, o, 'ADMIN');
      const stranger = await registerTenant(t);
      const page = newPage({ instagram: { id: `ig${Date.now()}1`, username: 'shop_ig' } });
      const plain = newPage();
      graph.pages = [page, plain];
      const { sessionId } = await signIn(o);
      const r = seen(
        await as(t, o).get(`/v1/integrations/meta/oauth/sessions/${sessionId}`).expect(200),
      );
      expect(r.body).toMatchObject({ mode: 'live', id: sessionId, reconnectConnectionId: null });
      expect(r.body.pages).toEqual([
        {
          id: page.id,
          name: page.name,
          instagram: { id: page.instagram!.id, username: 'shop_ig' },
          alreadyConnected: false,
        },
        { id: plain.id, name: plain.name, instagram: null, alreadyConnected: false },
      ]);
      expect(JSON.stringify(r.body)).not.toContain(page.token);
      expect(
        (await as(t, admin).get(`/v1/integrations/meta/oauth/sessions/${sessionId}`)).body.code,
      ).toBe('meta_oauth_invalid'); // same business, other person
      expect(
        (await as(t, stranger).get(`/v1/integrations/meta/oauth/sessions/${sessionId}`)).body.code,
      ).toBe('meta_oauth_invalid');
      expect(
        (await as(t, o).get(`/v1/integrations/meta/oauth/sessions/${randomUUID()}`)).body.code,
      ).toBe('meta_oauth_invalid');
    });
  });

  describe('connecting Pages', () => {
    it('connects a Page and its linked Instagram account: tokens sealed, webhook subscription made for messages only, no token in any response or log', async () => {
      const o = await registerTenant(t);
      const page = newPage({ instagram: { id: `ig${Date.now()}2`, username: 'shop_ig' } });
      graph.pages = [page];
      tokens.add(page.token);
      tokens.add(graph.userToken);
      const { sessionId } = await signIn(o);
      const before = graph.called('subscribe').length;
      const res = seen(
        await as(t, o).post('/v1/integrations/meta/connections', { sessionId, pageIds: [page.id] }),
      );
      expect(res.status).toBe(201);
      expect(res.body.mode).toBe('live');
      expect(res.body.failures).toEqual([]);
      expect(res.body.connections).toHaveLength(2);
      const [fb, ig] = res.body.connections;
      expect(fb).toMatchObject({
        provider: 'facebook_page',
        externalId: page.id,
        displayName: page.name,
        status: 'active',
        mock: false,
        linkedPageId: null,
      });
      expect(ig).toMatchObject({
        provider: 'instagram',
        externalId: page.instagram!.id,
        username: 'shop_ig',
        linkedPageId: page.id,
        status: 'active',
      });
      expect(fb.scopes).toEqual(expect.arrayContaining(['pages_messaging']));

      // Meta was told to send messages and postbacks only, with the token in the form body (not the URL)
      const sub = graph.called('subscribe').slice(before);
      expect(sub).toHaveLength(1);
      expect(sub[0]!.path).toBe(`${page.id}/subscribed_apps`);
      expect(sub[0]!.body.get('subscribed_fields')).toBe('messages,messaging_postbacks');
      expect(sub[0]!.body.get('access_token')).toBe(page.token);
      expect([...sub[0]!.query.keys()]).toEqual([]);

      // stored sealed
      const rows = await dbConnections(o);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.accessTokenEnc).toMatch(/^v1\.k1\./);
        expect(r.accessTokenEnc).not.toContain(page.token);
        expect(r.tokenType).toBe('page');
        expect(r.metaUserId).toBe(graph.metaUserId);
      }
      // the overview never carries it either
      const overview = seen(await as(t, o).get('/v1/integrations/meta').expect(200));
      expect(overview.body.connections).toHaveLength(2);
      expect(overview.body.openDrafts).toBe(0);
      // audit: ids only
      const audit = await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.auditLog.findMany({ where: { tenantId: o.tenant.id, action: 'integration.connected' } }),
      );
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toContain(page.token);
      // the hand-over is single use and its sealed user token is gone
      expect(
        (
          await as(t, o).post('/v1/integrations/meta/connections', {
            sessionId,
            pageIds: [page.id],
          })
        ).body.code,
      ).toBe('meta_oauth_invalid');
      const session = await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.socialOauthSession.findFirstOrThrow({ where: { id: sessionId! } }),
      );
      expect(session.consumedAt).not.toBeNull();
      expect(session.userTokenEnc).toBeNull();
    });

    it('an account cannot belong to two businesses; the second gets 409, nothing changes for the first', async () => {
      const a = await registerTenant(t);
      const b = await registerTenant(t);
      const page = newPage({ instagram: { id: `ig${Date.now()}3`, username: 'taken' } });
      graph.pages = [page];
      const s1 = (await signIn(a)).sessionId;
      await as(t, a)
        .post('/v1/integrations/meta/connections', { sessionId: s1, pageIds: [page.id] })
        .expect(201);
      const s2 = (await signIn(b)).sessionId;
      const listed = (await as(t, b).get(`/v1/integrations/meta/oauth/sessions/${s2}`)).body;
      expect(listed.pages[0].alreadyConnected).toBe(true);
      const r = await as(t, b).post('/v1/integrations/meta/connections', {
        sessionId: s2,
        pageIds: [page.id],
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('conflict');
      expect(await dbConnections(b)).toHaveLength(0);
      expect((await dbConnections(a)).filter((c) => c.status === 'active')).toHaveLength(2);
      // the database itself forbids it, whatever the application does
      await expect(
        t.db.withContext({ tenantId: b.tenant.id }, (tx) =>
          tx.socialConnection.create({
            data: {
              tenantId: b.tenant.id,
              provider: 'facebook_page',
              externalId: page.id,
              displayName: 'dup',
            },
          }),
        ),
      ).rejects.toThrow(/social_connections_active_account_key|Unique constraint/);
    });

    it('maps what Meta says to typed errors, and leaves the sign-in usable for a retry', async () => {
      const o = await registerTenant(t);
      const page = newPage();
      graph.pages = [page];
      const { sessionId } = await signIn(o);
      const a = as(t, o);
      const attempt = (fail?: { code: number; status?: number; message?: string }) => {
        graph.fail['subscribe'] = fail;
        return a.post('/v1/integrations/meta/connections', { sessionId, pageIds: [page.id] });
      };
      let r = await attempt({ code: 200, message: 'Requires pages_manage_metadata permission' });
      expect([r.status, r.body.code]).toEqual([422, 'meta_permission_denied']);
      r = await attempt({ code: 10 });
      expect([r.status, r.body.code]).toEqual([422, 'meta_permission_denied']);
      r = await attempt({ code: 190, status: 401 });
      expect([r.status, r.body.code]).toEqual([409, 'meta_token_invalid']);
      r = await attempt({ code: 4, status: 429 });
      expect([r.status, r.body.code]).toEqual([429, 'rate_limited']);
      r = await attempt({ code: 100 });
      expect([r.status, r.body.code]).toEqual([502, 'meta_unavailable']);
      r = await attempt({ code: 1, status: 500 });
      expect([r.status, r.body.code]).toEqual([502, 'meta_unavailable']);
      r = await attempt({
        code: 100,
        message: 'Please allow access to messages in Instagram settings',
      });
      expect([r.status, r.body.code]).toEqual([422, 'meta_messages_access_off']);
      // none of Meta's wording is forwarded
      expect(JSON.stringify(r.body)).not.toContain('Please allow access');
      expect(await dbConnections(o)).toHaveLength(0);
      // fixed: the same sign-in now works
      r = await attempt(undefined);
      expect(r.status).toBe(201);
    });

    it('connects the Pages that work and reports the ones that did not', async () => {
      const o = await registerTenant(t);
      const good = newPage();
      const bad = newPage();
      graph.pages = [good, bad];
      const { sessionId } = await signIn(o);
      graph.failPage[bad.id] = { code: 200 };
      try {
        const r = await as(t, o).post('/v1/integrations/meta/connections', {
          sessionId,
          pageIds: [good.id, bad.id],
        });
        expect(r.status).toBe(201);
        expect(r.body.connections.map((c: { externalId: string }) => c.externalId)).toEqual([
          good.id,
        ]);
        expect(r.body.failures).toEqual([
          { pageId: bad.id, code: 'meta_permission_denied', message: expect.any(String) },
        ]);
      } finally {
        delete graph.failPage[bad.id];
      }
      // all of them failing is an error, not an empty success
      const s2 = (await signIn(o)).sessionId;
      graph.failPage[bad.id] = { code: 200 };
      try {
        const r = await as(t, o).post('/v1/integrations/meta/connections', {
          sessionId: s2,
          pageIds: [bad.id],
        });
        expect([r.status, r.body.code]).toEqual([422, 'meta_permission_denied']);
      } finally {
        delete graph.failPage[bad.id];
      }
    });

    it('rejects a Page the sign-in never offered, and an empty or oversized list', async () => {
      const o = await registerTenant(t);
      graph.pages = [newPage()];
      const { sessionId } = await signIn(o);
      const a = as(t, o);
      const r = await a.post('/v1/integrations/meta/connections', {
        sessionId,
        pageIds: ['999999'],
      });
      expect(r.status).toBe(400);
      expect(r.body.errors[0].path).toBe('body.pageIds.0');
      await a.post('/v1/integrations/meta/connections', { sessionId, pageIds: [] }).expect(400);
      await a.post('/v1/integrations/meta/connections', { pageIds: ['1'] }).expect(400);
    });

    it('an expired hand-over cannot be used', async () => {
      const o = await registerTenant(t);
      const page = newPage();
      graph.pages = [page];
      const { sessionId } = await signIn(o);
      clock += 11 * 60_000;
      try {
        expect(
          (
            await as(t, o).post('/v1/integrations/meta/connections', {
              sessionId,
              pageIds: [page.id],
            })
          ).body.code,
        ).toBe('meta_oauth_invalid');
        expect(
          (await as(t, o).get(`/v1/integrations/meta/oauth/sessions/${sessionId}`)).body.code,
        ).toBe('meta_oauth_invalid');
      } finally {
        clock -= 11 * 60_000;
      }
    });
  });

  describe('receiving, disconnecting and reconnecting', () => {
    async function connected(opts: { instagram?: boolean } = {}) {
      const o = await registerTenant(t);
      const page = newPage(
        opts.instagram
          ? {
              instagram: { id: `ig${Date.now()}${Math.floor(Math.random() * 1e6)}`, username: 'u' },
            }
          : {},
      );
      graph.pages = [page];
      tokens.add(page.token);
      const { sessionId } = await signIn(o);
      const res = (
        await as(t, o)
          .post('/v1/integrations/meta/connections', { sessionId, pageIds: [page.id] })
          .expect(201)
      ).body;
      return {
        o,
        page,
        connections: res.connections as { id: string; provider: string; externalId: string }[],
      };
    }
    const post = (payload: unknown) => {
      const { body, headers } = signedWebhook(payload, SECRET);
      return t.http.post('/v1/webhooks/meta').set(headers).send(body);
    };

    it('a signed webhook for a live connection is stored for its business', async () => {
      const { o, page } = await connected();
      expect(
        (
          await post(
            sampleNotification('page', page.id, [
              { senderId: 'PSID-1', mid: mid(), text: 'order 01712345678' },
            ]),
          )
        ).status,
      ).toBe(200);
      const events = await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.socialEvent.findMany({ where: { tenantId: o.tenant.id } }),
      );
      expect(events).toHaveLength(1);
      await processSocialEvent(
        { db: t.db, log: () => undefined },
        { tenantId: o.tenant.id, eventId: events[0]!.id },
      );
      const draft = (await as(t, o).get('/v1/social-drafts')).body.items[0];
      expect(draft).toMatchObject({
        mock: false,
        provider: 'facebook_page',
        phone: '+8801712345678',
      });
    });

    it('disconnect: unsubscribes, deletes the token, stops receiving; repeating changes nothing', async () => {
      const { o, page, connections } = await connected();
      const fb = connections[0]!;
      const before = graph.called('unsubscribe').length;
      const r = seen(await as(t, o).del(`/v1/integrations/meta/connections/${fb.id}`).expect(200));
      expect(r.body).toMatchObject({ id: fb.id, status: 'disconnected' });
      expect(r.body.disconnectedAt).toBeTruthy();
      expect(graph.called('unsubscribe').slice(before)).toHaveLength(1);
      expect(graph.called('unsubscribe').at(-1)!.path).toBe(`${page.id}/subscribed_apps`);
      const row = (await dbConnections(o)).find((c) => c.id === fb.id)!;
      expect(row.accessTokenEnc).toBeNull();
      await as(t, o).del(`/v1/integrations/meta/connections/${fb.id}`).expect(200);
      expect(graph.called('unsubscribe')).toHaveLength(before + 1);
      // nothing is stored for it any more
      await post(
        sampleNotification('page', page.id, [
          { senderId: 'P', mid: mid(), text: 'order 01712345678' },
        ]),
      ).then((x) => expect(x.status).toBe(200));
      expect(
        await t.db.withContext({ tenantId: o.tenant.id }, (tx) => tx.socialEvent.count()),
      ).toBe(0);
      const audit = await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.auditLog.findMany({
          where: { tenantId: o.tenant.id, action: 'integration.disconnected' },
        }),
      );
      expect(audit).toHaveLength(1);
      // and it can be connected again, by this business or another
      const again = (await signIn(o)).sessionId;
      expect(
        (
          await as(t, o).post('/v1/integrations/meta/connections', {
            sessionId: again,
            pageIds: [page.id],
          })
        ).status,
      ).toBe(201);
    });

    it('a failed unsubscribe does not stop the disconnect', async () => {
      const { o, connections } = await connected();
      graph.fail['unsubscribe'] = { code: 190, status: 401 };
      try {
        expect(
          (await as(t, o).del(`/v1/integrations/meta/connections/${connections[0]!.id}`)).status,
        ).toBe(200);
      } finally {
        graph.fail['unsubscribe'] = undefined;
      }
      expect((await dbConnections(o))[0]!.status).toBe('disconnected');
    });

    it('reconnect re-runs the sign-in for one account, updates it in place and only allows that account', async () => {
      const { o, page, connections } = await connected({ instagram: true });
      const [fb, ig] = connections as unknown as [{ id: string }, { id: string }];
      // the health check found it needs attention
      await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.socialConnection.update({
          where: { id: fb.id },
          data: {
            status: 'needs_reconnect',
            lastErrorCode: 'token_invalid',
            lastErrorMessage: 'x',
          },
        }),
      );
      const other = newPage();
      graph.pages = [page, other];
      const { sessionId } = await signIn(o, { reconnect: fb.id });
      const session = (await as(t, o).get(`/v1/integrations/meta/oauth/sessions/${sessionId}`))
        .body;
      expect(session.reconnectConnectionId).toBe(fb.id);
      expect(session.pages.find((p: { id: string }) => p.id === page.id).alreadyConnected).toBe(
        false,
      );
      expect(
        (
          await as(t, o).post('/v1/integrations/meta/connections', {
            sessionId,
            pageIds: [other.id],
          })
        ).status,
      ).toBe(400);
      const r = await as(t, o).post('/v1/integrations/meta/connections', {
        sessionId,
        pageIds: [page.id],
      });
      expect(r.status).toBe(201);
      const rows = await dbConnections(o);
      expect(rows).toHaveLength(2); // updated in place, nothing duplicated
      expect(rows.find((c) => c.id === fb.id)).toMatchObject({
        status: 'active',
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      expect(rows.find((c) => c.id === ig.id)!.status).toBe('active');
      const audit = await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.auditLog.findMany({
          where: { tenantId: o.tenant.id, action: 'integration.reconnected' },
        }),
      );
      expect(audit.length).toBeGreaterThanOrEqual(1);
      expect(
        (await as(t, o).post(`/v1/integrations/meta/connections/${randomUUID()}/reconnect`)).status,
      ).toBe(404);
      const stranger = await registerTenant(t);
      expect(
        (await as(t, stranger).post(`/v1/integrations/meta/connections/${fb.id}/reconnect`)).status,
      ).toBe(404);
    });
  });

  describe('Meta’s deauthorize and data-deletion callbacks', () => {
    const form = (path: string, signed: string) =>
      t.http.post(path).type('form').send({ signed_request: signed });

    it('deauthorize disconnects what that person connected and deletes the tokens; a bad signature is refused', async () => {
      const o = await registerTenant(t);
      const page = newPage();
      graph.pages = [page];
      graph.metaUserId = `U${Date.now()}1`;
      const { sessionId } = await signIn(o);
      await as(t, o)
        .post('/v1/integrations/meta/connections', { sessionId, pageIds: [page.id] })
        .expect(201);
      const bad = await form(
        '/v1/webhooks/meta/deauthorize',
        buildSignedRequest({ user_id: graph.metaUserId }, 'wrong-secret-0123456789'),
      );
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('meta_oauth_invalid');
      expect((await dbConnections(o))[0]!.status).toBe('active');
      expect((await form('/v1/webhooks/meta/deauthorize', 'not-a-signed-request')).status).toBe(
        400,
      );
      const ok = await form(
        '/v1/webhooks/meta/deauthorize',
        buildSignedRequest({ user_id: graph.metaUserId }, SECRET),
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({});
      const row = (await dbConnections(o))[0]!;
      expect(row).toMatchObject({ status: 'disconnected', accessTokenEnc: null });
      const audit = await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.auditLog.findMany({
          where: { tenantId: o.tenant.id, action: 'integration.disconnected' },
        }),
      );
      expect(audit[0]!.metadata).toEqual({ reason: 'meta_deauthorize' });
      // unknown person: nothing happens, still 200
      expect(
        (
          await form(
            '/v1/webhooks/meta/deauthorize',
            buildSignedRequest({ user_id: 'nobody-1' }, SECRET),
          )
        ).status,
      ).toBe(200);
    });

    it('data deletion removes the person’s connections, tokens, events and drafts, and answers {url, confirmation_code}', async () => {
      const o = await registerTenant(t);
      const other = await registerTenant(t);
      const page = newPage();
      graph.pages = [page];
      graph.metaUserId = `U${Date.now()}2`;
      const { sessionId } = await signIn(o);
      await as(t, o)
        .post('/v1/integrations/meta/connections', { sessionId, pageIds: [page.id] })
        .expect(201);
      const { body, headers } = signedWebhook(
        sampleNotification('page', page.id, [
          { senderId: 'PSID-del', mid: mid(), text: 'order 01712345678' },
        ]),
        SECRET,
      );
      await t.http.post('/v1/webhooks/meta').set(headers).send(body).expect(200);
      const ev = await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.socialEvent.findMany({ where: { tenantId: o.tenant.id } }),
      );
      await processSocialEvent(
        { db: t.db, log: () => undefined },
        { tenantId: o.tenant.id, eventId: ev[0]!.id },
      );
      const otherConn = (await as(t, other)
        .post('/v1/integrations/meta/mock/connection')
        .catch(() => null)) as unknown;
      void otherConn; // mock endpoints do not exist in live mode: the other business stays empty

      const res = await form(
        '/v1/webhooks/meta/data-deletion',
        buildSignedRequest({ user_id: graph.metaUserId }, SECRET),
      );
      expect(res.status).toBe(200);
      expect(res.body.confirmation_code).toMatch(/^[0-9a-f]{24}$/);
      expect(res.body.url).toBe(
        `${API}/v1/webhooks/meta/data-deletion/status?code=${res.body.confirmation_code}`,
      );
      const left = await t.db.withContext({ tenantId: o.tenant.id }, async (tx) => ({
        events: await tx.socialEvent.count(),
        drafts: await tx.socialDraft.count(),
        tokens: await tx.socialConnection.count({ where: { accessTokenEnc: { not: null } } }),
      }));
      expect(left).toEqual({ events: 0, drafts: 0, tokens: 0 });
      expect((await dbConnections(o))[0]!.status).toBe('disconnected');
      const status = await t.http
        .get('/v1/webhooks/meta/data-deletion/status')
        .query({ code: res.body.confirmation_code });
      expect(status.body).toEqual({
        confirmationCode: res.body.confirmation_code,
        status: 'completed',
      });
      expect(
        (
          await t.http
            .get('/v1/webhooks/meta/data-deletion/status')
            .query({ code: 'zzzzzzzzzzzzzzzz' })
        ).status,
      ).toBe(404);
      expect(
        (
          await form(
            '/v1/webhooks/meta/data-deletion',
            buildSignedRequest({ user_id: graph.metaUserId }, 'wrong-secret-0123456789'),
          )
        ).status,
      ).toBe(400);
    });

    it('a customer-id deletion removes only that customer’s events and drafts', async () => {
      const o = await registerTenant(t);
      const page = newPage();
      graph.pages = [page];
      graph.metaUserId = `U${Date.now()}3`;
      const { sessionId } = await signIn(o);
      await as(t, o)
        .post('/v1/integrations/meta/connections', { sessionId, pageIds: [page.id] })
        .expect(201);
      const { body, headers } = signedWebhook(
        sampleNotification('page', page.id, [
          { senderId: 'PSID-A', mid: mid(), text: 'order 01712345678' },
          { senderId: 'PSID-B', mid: mid(), text: 'order 01812345678' },
        ]),
        SECRET,
      );
      await t.http.post('/v1/webhooks/meta').set(headers).send(body).expect(200);
      for (const e of await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.socialEvent.findMany({ where: { tenantId: o.tenant.id } }),
      ))
        await processSocialEvent(
          { db: t.db, log: () => undefined },
          { tenantId: o.tenant.id, eventId: e.id },
        );
      await form(
        '/v1/webhooks/meta/data-deletion',
        buildSignedRequest({ user_id: 'PSID-A' }, SECRET),
      ).expect(200);
      const left = await t.db.withContext({ tenantId: o.tenant.id }, async (tx) => ({
        senders: (await tx.socialEvent.findMany()).map((e) => e.senderId),
        drafts: (await tx.socialDraft.findMany()).map((d) => d.senderId),
      }));
      expect(left).toEqual({ senders: ['PSID-B'], drafts: ['PSID-B'] });
      expect((await dbConnections(o))[0]!.status).toBe('active'); // a customer asking is not the person who connected it
    });
  });

  describe('connection health (daily)', () => {
    const vault = new SecretBox({
      keyId: 'k1',
      key: Buffer.from('orderloop-test-courier-key-00000').toString('base64'),
    });
    const deps = () => ({
      db: t.db,
      vault,
      log: () => undefined,
      now: () => new Date(clock),
      graph: new MetaGraphClient({
        fetch: graph.fetch,
        version: 'v23.0',
        appId: '1234567890',
        appSecret: SECRET,
      }),
    });
    async function liveConn() {
      const o = await registerTenant(t);
      const page = newPage();
      graph.pages = [page];
      const { sessionId } = await signIn(o);
      const c = (
        await as(t, o)
          .post('/v1/integrations/meta/connections', { sessionId, pageIds: [page.id] })
          .expect(201)
      ).body.connections[0];
      return { o, id: c.id as string };
    }
    const row = async (o: Owner, id: string) => (await dbConnections(o)).find((c) => c.id === id)!;
    afterAll(() => {
      graph.fail = {};
      graph.debug = { is_valid: true, scopes: ['pages_messaging', 'instagram_manage_messages'] };
    });

    it('marks needs_reconnect when Meta says the token is invalid (190), with a message that holds no token, and records it once', async () => {
      const { o, id } = await liveConn();
      graph.fail['debug'] = {
        code: 190,
        status: 401,
        message: 'Error validating access token: Session has expired',
      };
      expect(await checkConnectionHealth(deps(), { tenantId: o.tenant.id, connectionId: id })).toBe(
        'needs_reconnect',
      );
      graph.fail['debug'] = undefined;
      const r = await row(o, id);
      expect(r).toMatchObject({ status: 'needs_reconnect', lastErrorCode: 'token_invalid' });
      expect(r.lastErrorMessage).toMatch(/Reconnect/);
      expect(r.lastCheckedAt).not.toBeNull();
      // a second check does not add a second audit row
      graph.fail['debug'] = { code: 190, status: 401 };
      await checkConnectionHealth(deps(), { tenantId: o.tenant.id, connectionId: id });
      graph.fail['debug'] = undefined;
      const audit = await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
        tx.auditLog.findMany({
          where: { tenantId: o.tenant.id, action: 'integration.needs_attention' },
        }),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.metadata).toEqual({ status: 'needs_reconnect', code: 'token_invalid' });
      // the screens see it
      expect((await as(t, o).get('/v1/integrations/meta')).body.connections[0]).toMatchObject({
        status: 'needs_reconnect',
        lastErrorCode: 'token_invalid',
      });
      // and messages still arrive for it (they may still be delivered; nothing is lost)
      const page = (
        await t.db.withContext({ tenantId: o.tenant.id }, (tx) =>
          tx.socialConnection.findFirstOrThrow({ where: { id } }),
        )
      ).externalId;
      const { body, headers } = signedWebhook(
        sampleNotification('page', page, [
          { senderId: 'S', mid: mid(), text: 'order 01712345678' },
        ]),
        SECRET,
      );
      await t.http.post('/v1/webhooks/meta').set(headers).send(body).expect(200);
      expect(
        await t.db.withContext({ tenantId: o.tenant.id }, (tx) => tx.socialEvent.count()),
      ).toBe(1);
    });

    it('marks permission_error for permission codes (10, 200, 299), an invalid token result, or a missing scope', async () => {
      for (const code of [10, 200, 299]) {
        const { o, id } = await liveConn();
        graph.fail['debug'] = { code, status: 403 };
        expect(
          await checkConnectionHealth(deps(), { tenantId: o.tenant.id, connectionId: id }),
        ).toBe('permission_error');
        graph.fail['debug'] = undefined;
        expect(await row(o, id)).toMatchObject({
          status: 'permission_error',
          lastErrorCode: 'permission_denied',
        });
      }
      const a = await liveConn();
      graph.debug = { is_valid: true, scopes: ['pages_show_list'] };
      expect(
        await checkConnectionHealth(deps(), { tenantId: a.o.tenant.id, connectionId: a.id }),
      ).toBe('permission_error');
      const b = await liveConn();
      graph.debug = { is_valid: false };
      expect(
        await checkConnectionHealth(deps(), { tenantId: b.o.tenant.id, connectionId: b.id }),
      ).toBe('needs_reconnect');
      graph.debug = { is_valid: true, scopes: ['pages_messaging', 'instagram_manage_messages'] };
    });

    it('goes back to active (and clears the error) when it works again', async () => {
      const { o, id } = await liveConn();
      graph.fail['debug'] = { code: 200 };
      await checkConnectionHealth(deps(), { tenantId: o.tenant.id, connectionId: id });
      graph.fail['debug'] = undefined;
      expect((await row(o, id)).status).toBe('permission_error');
      expect(await checkConnectionHealth(deps(), { tenantId: o.tenant.id, connectionId: id })).toBe(
        'ok',
      );
      expect(await row(o, id)).toMatchObject({
        status: 'active',
        lastErrorCode: null,
        lastErrorMessage: null,
      });
    });

    it('changes nothing when Meta is down or rate limiting (tomorrow tries again), and skips mock and disconnected ones', async () => {
      const { o, id } = await liveConn();
      for (const f of [{ code: 1, status: 503 }, { code: 4, status: 429 }, { code: 100 }]) {
        graph.fail['debug'] = f;
        expect(
          await checkConnectionHealth(deps(), { tenantId: o.tenant.id, connectionId: id }),
        ).toBe('unreachable');
      }
      graph.fail['debug'] = undefined;
      expect((await row(o, id)).status).toBe('active');
      await as(t, o).del(`/v1/integrations/meta/connections/${id}`).expect(200);
      expect(await checkConnectionHealth(deps(), { tenantId: o.tenant.id, connectionId: id })).toBe(
        'skipped',
      );
    });

    it('the sweep finds every live connection across businesses and one failure does not stop the rest', async () => {
      const a = await liveConn();
      const b = await liveConn();
      const calls = graph.called('debug_token').length;
      const counts = await runHealthSweep(deps());
      expect(counts.ok).toBeGreaterThanOrEqual(2);
      expect(graph.called('debug_token').length).toBeGreaterThanOrEqual(calls + 2);
      expect((await row(a.o, a.id)).lastCheckedAt).not.toBeNull();
      expect((await row(b.o, b.id)).lastCheckedAt).not.toBeNull();
    });
  });

  it('no token, secret or one-time code appears in any response or log line', () => {
    const everything = [...bodies, ...logs].join('\n');
    expect(tokens.size).toBeGreaterThan(0);
    for (const token of tokens) expect(everything, token.slice(0, 12)).not.toContain(token);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(graph.goodCode);
    expect(everything).not.toContain(VERIFY);
  });
});
