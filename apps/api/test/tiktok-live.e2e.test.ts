import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  TikTokApiError,
  checkTikTokConnectionHealth,
  processTikTokEvent,
  purgeTikTokData,
  refreshDueTikTokTokens,
  refreshTikTokTokens,
  runTikTokHealthSweep,
  sampleOrderStatusEvent,
  signedTikTokWebhook,
  syncTikTokConnection,
  tiktokSecretScope,
  TikTokEventJob,
} from '@orderloop/automation';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  createProduct,
  createTestApp,
  registerTenant,
  type TestApp,
} from './app.js';
import { drain, fakeQueue } from './automation-helpers.js';
import { findLeaks, tenantText, withAdmin } from './deletion-helpers.js';
import {
  API_HOST,
  APP_KEY,
  APP_SECRET,
  AUTH_HOST,
  BUYER_NEEDLES,
  countingMetrics,
  fakeTikTok,
  newShop,
  rawOrder,
  workerDeps,
  type FakeTikTok,
} from './tiktok-helpers.js';
import { MetricsService } from '../src/metrics/metrics.service.js';

/**
 * TikTok Shop in LIVE mode against a fake TikTok (the injected `fetch`, which checks request signatures, access tokens, the app
 * secret and that a refresh token works once): sign-in, token lifecycle, webhooks that fetch the order, the catch-up check, health
 * and retention. The live path has NEVER run against the real TikTok: this proves OrderLoop's own behaviour only.
 */
const API = 'https://api.test.example';
const WEB = 'https://app.test.example';
const LIVE_ENV = {
  TIKTOK_MODE: 'live',
  TIKTOK_APP_KEY: APP_KEY,
  TIKTOK_APP_SECRET: APP_SECRET,
  TIKTOK_AUTH_HOST: AUTH_HOST,
  TIKTOK_API_HOST: API_HOST,
  API_PUBLIC_URL: API,
  WEB_APP_URL: WEB,
};

let t: TestApp;
let fake: FakeTikTok;
/** The API's clock: a test moves it to expire a sign-in without waiting. */
const clock = { offset: 0 };
const now = () => new Date(Date.now() + clock.offset);
const queue = fakeQueue();
const logs: string[] = [];
const wire: string[] = [];
const { counts, metrics } = countingMetrics();

const newFake = () => fakeTikTok({ now, accessLifetimeSec: 10 * 86_400 });

beforeAll(async () => {
  fake = newFake();
  t = await createTestApp(LIVE_ENV, {
    logDestination: new Writable({ write: (chunk, _e, cb) => (logs.push(String(chunk)), cb()) }),
    // every test installs its own fake TikTok behind this one stable function
    tiktok: { events: queue, fetch: (...a: Parameters<typeof fetch>) => fake.fetch(...a), now },
  });
});
afterAll(() => t.close());
beforeEach(async () => {
  clock.offset = 0;
  fake = newFake();
  // Connections left over from earlier tests hold tokens this test's fake TikTok does not know: keep the renewal scan off them.
  await withAdmin((c) =>
    c.query(
      `UPDATE tiktok_connections SET next_refresh_at = now() + interval '30 days' WHERE NOT mock`,
    ),
  );
});

type Who = { accessToken: string };
const as = (who: Who) => ({
  get: (p: string) => t.http.get(p).set(bearer(who.accessToken)),
  post: (p: string, b: object = {}) => t.http.post(p).set(bearer(who.accessToken)).send(b),
  put: (p: string, b: object) => t.http.put(p).set(bearer(who.accessToken)).send(b),
  del: (p: string) => t.http.delete(p).set(bearer(who.accessToken)),
});

/** Record every body we get back, so "no token anywhere" is checked over everything a person's browser could see. */
const seen = <T extends { body: unknown; text: string; headers: Record<string, unknown> }>(
  res: T,
): T => {
  wire.push(JSON.stringify(res.body), res.text, JSON.stringify(res.headers));
  return res;
};

const path = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};
const cookieOf = (res: { headers: Record<string, unknown> }) =>
  String(((res.headers['set-cookie'] as string[] | undefined) ?? [])[0] ?? '').split(';')[0]!;

/** start -> begin: what the person's browser does before TikTok's page. */
async function beginSignIn(who: Who, reconnectId?: string) {
  const api = as(who);
  const start = seen(
    await (
      reconnectId
        ? api.post(`/v1/integrations/tiktok-shop/connections/${reconnectId}/reconnect`)
        : api.post('/v1/integrations/tiktok-shop/oauth/start')
    ).expect(200),
  );
  const begin = seen(await t.http.get(path(start.body.authorizeUrl)).expect(302));
  const location = begin.headers['location'] as string;
  return {
    start,
    begin,
    location,
    state: new URL(location).searchParams.get('state')!,
    cookie: cookieOf(begin),
  };
}
const callback = async (state: string, cookie: string | null, extra = '&code=GOOD_AUTH_CODE') =>
  seen(
    await t.http
      .get(`/v1/integrations/tiktok-shop/oauth/callback?state=${encodeURIComponent(state)}${extra}`)
      .set(cookie ? { Cookie: cookie } : {}),
  );
const redirectOf = async (p: ReturnType<typeof callback>) => {
  const res = await p;
  expect(res.status).toBe(302);
  return new URL(res.headers['location'] as string);
};

/** A whole successful sign-in and selection: returns the connections made. */
async function signInAndConnect(who: Who, shopIds: string[], reconnectId?: string) {
  const s = await beginSignIn(who, reconnectId);
  const back = await redirectOf(callback(s.state, s.cookie));
  const session = back.searchParams.get('session');
  expect(session, back.toString()).toBeTruthy();
  const res = seen(
    await as(who).post('/v1/integrations/tiktok-shop/connections', { sessionId: session, shopIds }),
  );
  return { session: session!, res };
}

/** A business with its own shops connected through the real sign-in. */
async function liveBusiness(opts: { shops?: number; orders?: ReturnType<typeof rawOrder>[] } = {}) {
  const owner = await registerTenant(t);
  const shops = Array.from({ length: opts.shops ?? 1 }, () => newShop());
  fake.shops.push(...shops);
  for (const o of opts.orders ?? []) fake.orders.set(o.id, o);
  const { res } = await signInAndConnect(
    owner,
    shops.map((s) => s.id),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const connections = res.body.connections as { id: string; shopId: string }[];
  const { variant } = await createProduct(t, owner.accessToken, {
    sku: `LV-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`.toUpperCase(),
  });
  await as(owner).post('/v1/inventory/receive', { variantId: variant.id, quantity: 20 });
  const level = async () =>
    (
      (await as(owner).get(`/v1/inventory?variantId=${variant.id}`)).body.items as {
        onHand: number;
        reserved: number;
      }[]
    )[0]!;
  const deps = workerDeps(t, fake, { now, metrics });
  const row = (id = connections[0]!.id) =>
    withAdmin(
      async (c) =>
        (await c.query('SELECT * FROM tiktok_connections WHERE id = $1', [id])).rows[0] as Record<
          string,
          unknown
        > & {
          access_token_enc: string | null;
          refresh_token_enc: string | null;
          status: string;
          refresh_failures: number;
          next_refresh_at: Date | null;
          access_expires_at: Date | null;
          last_synced_at: Date | null;
          grant_id: string;
        },
    );
  const orderRows = () =>
    withAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT external_order_id, status, stock_state::text AS stock_state, line_items FROM tiktok_orders WHERE tenant_id = $1 ORDER BY external_order_id`,
            [owner.tenant.id],
          )
        ).rows as {
          external_order_id: string;
          status: string;
          stock_state: string;
          line_items: unknown;
        }[],
    );
  const audit = async (action: string) =>
    ((await as(owner).get('/v1/audit-logs?limit=100')).body.items as { action: string }[]).filter(
      (a) => a.action === action,
    ).length;
  /** Make the access token due for renewal (inside its window) without waiting for time. */
  const makeDue = (id = connections[0]!.id) =>
    withAdmin((c) =>
      c.query(
        `UPDATE tiktok_connections SET access_expires_at = now() + interval '30 minutes', tokens_obtained_at = now() - interval '9 days' WHERE id = $1`,
        [id],
      ),
    );
  return { owner, shops, connections, variant, level, deps, row, orderRows, audit, makeDue };
}

const decrypt = (
  b: Awaited<ReturnType<typeof liveBusiness>>,
  kind: 'access' | 'refresh',
  sealed: string,
) => b.deps.vault.decrypt(sealed, tiktokSecretScope(b.owner.tenant.id, kind));
const nowSec = () => Math.floor(Date.now() / 1000);

describe('live mode surface', () => {
  it('reports live mode with the webhook and redirect addresses to register, and the mock calls do not exist', async () => {
    const owner = await registerTenant(t);
    const o = seen(await as(owner).get('/v1/integrations/tiktok-shop').expect(200)).body;
    expect(o).toMatchObject({
      mode: 'live',
      liveConfigured: true,
      webhookUrl: `${API}/v1/webhooks/tiktok-shop`,
      redirectUrl: `${API}/v1/integrations/tiktok-shop/oauth/callback`,
      connections: [],
    });
    const api = as(owner);
    expect((await api.post('/v1/integrations/tiktok-shop/mock/connection', {})).status).toBe(404);
    expect(
      (
        await api.post('/v1/integrations/tiktok-shop/mock/orders', {
          connectionId: randomUUID(),
          items: [{ skuId: 'a' }],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api.post(`/v1/integrations/tiktok-shop/mock/orders/${randomUUID()}/status`, {
          status: 'CANCELLED',
        })
      ).status,
    ).toBe(404);
  });
});

describe('sign-in: the CSRF-hardened flow', () => {
  it('begin redirects to TikTok with the app key and a signed state, binds the browser with an HttpOnly SameSite=Lax cookie, and works once', async () => {
    const owner = await registerTenant(t);
    const s = await beginSignIn(owner);
    const loc = new URL(s.location);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${AUTH_HOST}/oauth/authorize`);
    expect(loc.searchParams.get('app_key')).toBe(APP_KEY);
    expect(s.state.split('.')).toHaveLength(2);
    expect(s.state).not.toContain(APP_SECRET);
    const setCookie = String(([] as string[]).concat(s.begin.headers['set-cookie'] ?? [])[0]);
    expect(setCookie).toMatch(/^ol_tiktok_oauth=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/v1\/integrations\/tiktok-shop\/oauth/);
    expect(s.begin.headers['cache-control']).toBe('no-store');
    expect(s.start.body.authorizeUrl).toMatch(
      new RegExp(`^${API}/v1/integrations/tiktok-shop/oauth/begin\\?ticket=`),
    );
    // the ticket is single use
    const again = await t.http.get(path(s.start.body.authorizeUrl)).expect(302);
    expect(String(again.headers['location'])).toBe(
      `${WEB}/settings/integrations/tiktok-shop?error=invalid_state`,
    );
    expect(again.headers['set-cookie']).toBeUndefined();
    // and an unknown or missing one goes nowhere
    for (const q of ['?ticket=nope', '']) {
      const bad = await t.http.get(`/v1/integrations/tiktok-shop/oauth/begin${q}`).expect(302);
      expect(String(bad.headers['location'])).toContain('error=invalid_state');
    }
  });

  it('a ticket older than its 60 seconds is refused', async () => {
    const owner = await registerTenant(t);
    const start = await as(owner).post('/v1/integrations/tiktok-shop/oauth/start').expect(200);
    clock.offset = 61_000;
    const begin = await t.http.get(path(start.body.authorizeUrl)).expect(302);
    expect(String(begin.headers['location'])).toContain('error=invalid_state');
  });

  it('the callback refuses a tampered state, a missing or wrong cookie, a replay and an expired state; the right browser can still finish', async () => {
    const owner = await registerTenant(t);
    const s = await beginSignIn(owner);
    const flip = (v: string) => v.slice(0, -2) + (v.slice(-2) === 'AA' ? 'BB' : 'AA');
    const errorOf = async (state: string, cookie: string | null) =>
      (await redirectOf(callback(state, cookie))).searchParams.get('error');
    expect(await errorOf(flip(s.state), s.cookie)).toBe('invalid_state');
    expect(await errorOf('garbage', s.cookie)).toBe('invalid_state');
    expect(await errorOf(s.state, null)).toBe('invalid_state');
    expect(await errorOf(s.state, 'ol_tiktok_oauth=wrong')).toBe('invalid_state');
    // a stranger's failed attempts did not use the sign-in up
    const back = await redirectOf(callback(s.state, s.cookie));
    expect(back.searchParams.get('session')).toBeTruthy();
    // replay: the state is single use
    expect(await errorOf(s.state, s.cookie)).toBe('invalid_state');
    // expired: the state is only good for ten minutes
    const late = await beginSignIn(owner);
    clock.offset = 11 * 60_000;
    expect(await errorOf(late.state, late.cookie)).toBe('invalid_state');
  });

  it('the callback clears the cookie whatever happened, and never puts a token in the address', async () => {
    const owner = await registerTenant(t);
    fake.shops.push(newShop());
    const s = await beginSignIn(owner);
    const res = await callback(s.state, s.cookie);
    expect(String(([] as string[]).concat(res.headers['set-cookie'] ?? [])[0])).toMatch(
      /^ol_tiktok_oauth=;/,
    );
    const location = String(res.headers['location']);
    expect(location).not.toMatch(/token|GOOD_AUTH_CODE/i);
    expect(location).toMatch(
      new RegExp(`^${WEB}/settings/integrations/tiktok-shop\\?session=[0-9a-f-]{36}$`),
    );
  });

  type Failure = { step: string; status: number; code: number; message?: string };
  const cases: [string, string, Failure | null, string][] = [
    ['the seller says no', '&error=access_denied', null, 'access_denied'],
    ['no code arrives', '', null, 'access_denied'],
    ['TikTok rejects the code', '&code=WRONG', null, 'tiktok_token_invalid'],
    [
      'TikTok limits requests',
      '&code=GOOD_AUTH_CODE',
      { step: 'token', status: 429, code: 429 },
      'rate_limited',
    ],
    [
      'TikTok is down',
      '&code=GOOD_AUTH_CODE',
      { step: 'token', status: 500, code: 500 },
      'tiktok_unavailable',
    ],
    [
      'TikTok refuses the shop list',
      '&code=GOOD_AUTH_CODE',
      { step: 'shops', status: 403, code: 105005, message: 'permission denied for scope' },
      'tiktok_permission_denied',
    ],
  ];
  it.each(cases)(
    '%s: the person comes back with error=%s',
    async (_label, extra, failure, code) => {
      const owner = await registerTenant(t);
      fake.shops.push(newShop());
      if (failure)
        fake.fail[failure.step] = {
          status: failure.status,
          code: failure.code,
          ...(failure.message ? { message: failure.message } : {}),
        };
      const s = await beginSignIn(owner);
      const back = await redirectOf(callback(s.state, s.cookie, extra));
      expect(back.searchParams.get('error')).toBe(code);
      expect(back.searchParams.get('session')).toBeNull();
    },
  );
});

describe('choosing shops and connecting', () => {
  it('lists the offered shops (names and ids only), then connects them: sealed tokens, a webhook subscription, the first read of orders', async () => {
    const owner = await registerTenant(t);
    const [a, b] = [
      newShop({ name: 'Shop A', region: 'MY' }),
      newShop({ name: 'Shop B', region: 'SG' }),
    ];
    fake.shops.push(a, b);
    const recent = rawOrder({
      id: 'BF-1',
      updateTime: nowSec() - 3600,
      lines: [{ skuId: 'bf-sku', sellerSku: 'NO-MATCH-1', units: 2 }],
    });
    fake.orders.set(recent.id, recent);
    const s = await beginSignIn(owner);
    const back = await redirectOf(callback(s.state, s.cookie));
    const sessionId = back.searchParams.get('session')!;
    const session = seen(
      await as(owner).get(`/v1/integrations/tiktok-shop/oauth/sessions/${sessionId}`).expect(200),
    ).body;
    expect(session).toMatchObject({ mode: 'live', id: sessionId, reconnectConnectionId: null });
    expect(session.shops).toEqual(
      expect.arrayContaining([
        { id: a.id, name: 'Shop A', region: 'MY', sellerType: 'LOCAL', alreadyConnected: false },
        { id: b.id, name: 'Shop B', region: 'SG', sellerType: 'LOCAL', alreadyConnected: false },
      ]),
    );
    expect(JSON.stringify(session)).not.toMatch(/cipher|ROW_/);

    const res = seen(
      await as(owner)
        .post('/v1/integrations/tiktok-shop/connections', { sessionId, shopIds: [a.id, b.id] })
        .expect(201),
    );
    expect(res.body.mode).toBe('live');
    expect(res.body.failures).toEqual([]);
    expect(res.body.connections).toHaveLength(2);
    expect(res.body.connections[0]).toMatchObject({
      mock: false,
      status: 'active',
      shopName: 'Shop A',
      region: 'MY',
      scopes: ['seller.order.info', 'seller.authorization.info'],
    });
    expect(res.body.connections[0].tokenExpiresAt).toBeTruthy();
    const body = JSON.stringify(res.body);
    for (const secret of [fake.access, fake.refresh, 'GOOD_AUTH_CODE', APP_SECRET, a.cipher])
      expect(body).not.toContain(secret);

    // stored sealed (never plain), both shops of one sign-in share a grant
    const rows = await withAdmin(
      async (c) =>
        (
          await c.query(
            'SELECT access_token_enc, refresh_token_enc, shop_cipher, grant_id, tokens_obtained_at FROM tiktok_connections WHERE tenant_id = $1 ORDER BY shop_name',
            [owner.tenant.id],
          )
        ).rows,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.access_token_enc).toMatch(/^v1\./);
      expect(r.refresh_token_enc).toMatch(/^v1\./);
      expect(r.access_token_enc).not.toContain(fake.access);
      expect(r.refresh_token_enc).not.toContain(fake.refresh);
      expect(r.tokens_obtained_at).toBeTruthy();
    }
    expect(rows[0].grant_id).toBe(rows[1].grant_id);
    expect(rows[0].shop_cipher).toBe(a.cipher);

    // the webhook subscription was attempted (best effort) with the right address, and orders were read
    const hook = fake.called('/event/202309/webhooks')[0]!;
    expect(hook.method).toBe('PUT');
    expect(JSON.parse(hook.body!)).toEqual({
      address: `${API}/v1/webhooks/tiktok-shop`,
      event_type: 'ORDER_STATUS_CHANGE',
    });
    expect(fake.called('/order/202309/orders/search').length).toBeGreaterThanOrEqual(1);
    const mirrored = await withAdmin(
      async (c) =>
        (
          await c.query(
            'SELECT external_order_id, stock_state::text s FROM tiktok_orders WHERE tenant_id = $1',
            [owner.tenant.id],
          )
        ).rows,
    );
    // (the fake TikTok answers every shop with the same order list, so each shop mirrors it)
    expect(mirrored).toEqual([
      { external_order_id: 'BF-1', s: 'needs_mapping' },
      { external_order_id: 'BF-1', s: 'needs_mapping' },
    ]);
    const overview = (await as(owner).get('/v1/integrations/tiktok-shop')).body;
    expect(
      overview.connections.map((c: { lastSyncedAt: string | null }) => c.lastSyncedAt !== null),
    ).toContain(true);
    expect(
      await withAdmin(
        async (c) =>
          (
            await c.query(
              `SELECT count(*)::int n FROM audit_logs WHERE tenant_id = $1 AND action = 'integration.tiktok_connected'`,
              [owner.tenant.id],
            )
          ).rows[0].n,
      ),
    ).toBe(2);

    // a hand-over is used once
    const reuse = await as(owner).post('/v1/integrations/tiktok-shop/connections', {
      sessionId,
      shopIds: [a.id],
    });
    expect(reuse.status).toBe(400);
    expect(reuse.body.code).toBe('tiktok_oauth_invalid');
    expect(
      await withAdmin(
        async (c) =>
          (await c.query('SELECT grant_enc FROM tiktok_oauth_sessions WHERE id = $1', [sessionId]))
            .rows[0].grant_enc,
      ),
    ).toBeNull();
  });

  it('only the person who signed in can see or use the hand-over, and only for a shop it offered', async () => {
    const owner = await registerTenant(t);
    const admin = await addMember(t, owner, 'ADMIN');
    const stranger = await registerTenant(t);
    const shop = newShop();
    fake.shops.push(shop);
    const s = await beginSignIn(owner);
    const sessionId = (await redirectOf(callback(s.state, s.cookie))).searchParams.get('session')!;
    for (const who of [admin, stranger]) {
      const r = await as(who).get(`/v1/integrations/tiktok-shop/oauth/sessions/${sessionId}`);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('tiktok_oauth_invalid');
      expect(
        (
          await as(who).post('/v1/integrations/tiktok-shop/connections', {
            sessionId,
            shopIds: [shop.id],
          })
        ).status,
      ).toBe(400);
    }
    const wrong = await as(owner).post('/v1/integrations/tiktok-shop/connections', {
      sessionId,
      shopIds: ['12345'],
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.errors[0].path).toBe('body.shopIds.0');
    expect(
      (await as(owner).get(`/v1/integrations/tiktok-shop/oauth/sessions/${randomUUID()}`)).body
        .code,
    ).toBe('tiktok_oauth_invalid');
    clock.offset = 11 * 60_000;
    expect(
      (await as(owner).get(`/v1/integrations/tiktok-shop/oauth/sessions/${sessionId}`)).body.code,
    ).toBe('tiktok_oauth_invalid');
  });

  it('one shop belongs to one business: it shows as taken, a connect that is only that shop is refused, a mixed one lists the failure', async () => {
    const first = await liveBusiness();
    const takenId = first.shops[0]!.id;
    const second = await registerTenant(t);
    const free = newShop();
    fake.shops.push(free);
    const s = await beginSignIn(second);
    const sessionId = (await redirectOf(callback(s.state, s.cookie))).searchParams.get('session')!;
    const session = (
      await as(second).get(`/v1/integrations/tiktok-shop/oauth/sessions/${sessionId}`).expect(200)
    ).body;
    expect(session.shops.find((x: { id: string }) => x.id === takenId).alreadyConnected).toBe(true);
    expect(session.shops.find((x: { id: string }) => x.id === free.id).alreadyConnected).toBe(
      false,
    );
    const only = await as(second).post('/v1/integrations/tiktok-shop/connections', {
      sessionId,
      shopIds: [takenId],
    });
    expect(only.status).toBe(409);
    expect(only.body.code).toBe('conflict');
    const mixed = await as(second).post('/v1/integrations/tiktok-shop/connections', {
      sessionId,
      shopIds: [takenId, free.id],
    });
    expect(mixed.status).toBe(201);
    expect(mixed.body.connections.map((c: { shopId: string }) => c.shopId)).toEqual([free.id]);
    expect(mixed.body.failures).toEqual([
      expect.objectContaining({ shopId: takenId, code: 'conflict' }),
    ]);
    // the database holds the line too
    const dup = await withAdmin((c) =>
      c
        .query(
          `INSERT INTO tiktok_connections (id, tenant_id, grant_id, shop_id, shop_name, updated_at) VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, 'dup', now())`,
          [second.tenant.id, takenId],
        )
        .then(
          () => 'inserted',
          (e: { code?: string }) => e.code,
        ),
    );
    expect(dup).toBe('23505');
  });

  it('reconnecting restarts the sign-in for that one shop, keeps the connection and its orders, and audits it', async () => {
    const b = await liveBusiness({
      orders: [
        rawOrder({
          id: 'RC-1',
          updateTime: nowSec() - 600,
          lines: [{ skuId: 'rc', sellerSku: 'X-RC' }],
        }),
      ],
    });
    const id = b.connections[0]!.id;
    await withAdmin((c) =>
      c.query(
        `UPDATE tiktok_connections SET status = 'needs_reconnect', last_error_code = 'token_invalid' WHERE id = $1`,
        [id],
      ),
    );
    const other = newShop();
    fake.shops.push(other);
    const s = await beginSignIn(b.owner, id);
    const sessionId = (await redirectOf(callback(s.state, s.cookie))).searchParams.get('session')!;
    const session = (
      await as(b.owner).get(`/v1/integrations/tiktok-shop/oauth/sessions/${sessionId}`).expect(200)
    ).body;
    expect(session.reconnectConnectionId).toBe(id);
    expect(
      session.shops.find((x: { id: string }) => x.id === b.shops[0]!.id).alreadyConnected,
    ).toBe(false); // ours: the point
    const wrong = await as(b.owner).post('/v1/integrations/tiktok-shop/connections', {
      sessionId,
      shopIds: [other.id],
    });
    expect(wrong.status).toBe(400);
    const ok = await as(b.owner).post('/v1/integrations/tiktok-shop/connections', {
      sessionId,
      shopIds: [b.shops[0]!.id],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.connections[0]).toMatchObject({ id, status: 'active', lastErrorCode: null });
    expect((await b.orderRows()).map((o) => o.external_order_id)).toEqual(['RC-1']);
    expect(await b.audit('integration.tiktok_reconnected')).toBe(1);
    expect((await as(b.owner).get('/v1/integrations/tiktok-shop')).body.connections).toHaveLength(
      1,
    );
  });

  it('disconnecting deletes the sealed tokens and the cipher; later deliveries are ignored; connecting again revives the same connection', async () => {
    const b = await liveBusiness({
      orders: [
        rawOrder({
          id: 'DC-1',
          updateTime: nowSec() - 600,
          lines: [{ skuId: 'dc', sellerSku: 'X-DC' }],
        }),
      ],
    });
    const id = b.connections[0]!.id;
    seen(await as(b.owner).del(`/v1/integrations/tiktok-shop/connections/${id}`).expect(200));
    const r = await b.row();
    expect([
      r.status,
      r.access_token_enc,
      r.refresh_token_enc,
      r['shop_cipher'],
      r.access_expires_at,
    ]).toEqual(['disconnected', null, null, null, null]);
    expect(
      (await as(b.owner).post(`/v1/integrations/tiktok-shop/connections/${id}/sync`)).status,
    ).toBe(409);
    const hook = signedTikTokWebhook(
      sampleOrderStatusEvent({
        shopId: b.shops[0]!.id,
        orderId: 'DC-1',
        status: 'CANCELLED',
        notificationId: `n-${randomUUID()}`,
      }),
      APP_KEY,
      APP_SECRET,
    );
    await t.http.post('/v1/webhooks/tiktok-shop').set(hook.headers).send(hook.body).expect(200);
    expect(
      await withAdmin(
        async (c) =>
          (
            await c.query(
              `SELECT status::text s, error FROM tiktok_events WHERE connection_id = $1 ORDER BY created_at DESC LIMIT 1`,
              [id],
            )
          ).rows[0],
      ),
    ).toEqual({ s: 'ignored', error: 'connection_disconnected' });
    const again = await signInAndConnect(b.owner, [b.shops[0]!.id]);
    expect(again.res.status).toBe(201);
    expect(again.res.body.connections[0].id).toBe(id);
    expect((await b.orderRows()).map((o) => o.external_order_id)).toEqual(['DC-1']);
  });
});

describe('what never leaks', () => {
  it('no token, auth code, app secret or cipher is in any response, any redirect, any log line, or stored in the clear', async () => {
    const b = await liveBusiness({
      orders: [
        rawOrder({
          id: 'LK-1',
          updateTime: nowSec() - 600,
          lines: [{ skuId: 'lk', sellerSku: 'X-LK' }],
        }),
      ],
    });
    await as(b.owner).get('/v1/integrations/tiktok-shop');
    const secrets = [fake.access, fake.refresh, 'GOOD_AUTH_CODE', APP_SECRET, b.shops[0]!.cipher];
    const everything = [...wire, ...logs].join('\n');
    for (const s of secrets) expect(everything, `leaked ${s.slice(0, 12)}`).not.toContain(s);
    const stored = await withAdmin(async (c) => {
      const cells = await tenantText(c, b.owner.tenant.id);
      return cells
        .filter((x) => secrets.slice(0, 4).some((s) => x.value.includes(s)))
        .map((x) => `${x.table}.${x.column}`);
    });
    expect(stored).toEqual([]);
    // and what went on the wire to TikTok carries the access token only in the header, never in the URL
    for (const call of fake.calls)
      if (call.host === 'api') {
        expect(call.query.has('access_token')).toBe(false);
        expect(call.path + call.query.toString()).not.toContain(fake.access);
      }
  });
});

describe('a webhook for a live shop: the order is fetched, never trusted from the notification', () => {
  it('mirrors what TikTok says now, links nothing it cannot, reserves, ships once, and stores no buyer data', async () => {
    const b = await liveBusiness();
    const sku = (await as(b.owner).get(`/v1/inventory?variantId=${b.variant.id}`)).body.items[0]
      .sku as string;
    fake.orders.set(
      'LV-1',
      rawOrder({
        id: 'LV-1',
        status: 'AWAITING_SHIPMENT',
        updateTime: nowSec() - 100,
        lines: [{ skuId: 'lv-sku', sellerSku: sku.toLowerCase(), units: 3, price: '12.50' }],
      }),
    );
    const send = async (status: string, notificationId = `n-${randomUUID()}`) => {
      const h = signedTikTokWebhook(
        sampleOrderStatusEvent({ shopId: b.shops[0]!.id, orderId: 'LV-1', status, notificationId }),
        APP_KEY,
        APP_SECRET,
      );
      const res = await t.http.post('/v1/webhooks/tiktok-shop').set(h.headers).send(h.body);
      expect(res.status).toBe(200);
      expect(res.text).toBe('');
    };
    const run = () =>
      drain(queue, (job) => processTikTokEvent(b.deps.process, TikTokEventJob.parse(job.data)));
    // the queue still holds earlier tests' jobs: only this business's matter
    for (const j of queue.pending()) if (j.data['tenantId'] !== b.owner.tenant.id) j.done = true;
    await send('AWAITING_SHIPMENT');
    await run();
    let order = (await as(b.owner).get('/v1/tiktok-orders')).body.items[0];
    expect(order).toMatchObject({
      externalOrderId: 'LV-1',
      stockState: 'reserved',
      currency: 'MYR',
      currencyExponent: 2,
      unitCount: 3,
      mock: false,
    });
    expect(order.totalMinor).toBe(3750 + 250 - 100);
    expect(await b.level()).toMatchObject({ onHand: 20, reserved: 3 });

    // TikTok now says IN_TRANSIT, but the notification that arrives still says AWAITING_SHIPMENT: the fetched status wins
    fake.orders.set(
      'LV-1',
      rawOrder({
        id: 'LV-1',
        status: 'IN_TRANSIT',
        updateTime: nowSec(),
        lines: [{ skuId: 'lv-sku', sellerSku: sku, units: 3, price: '12.50' }],
      }),
    );
    await send('AWAITING_SHIPMENT');
    await run();
    order = (await as(b.owner).get('/v1/tiktok-orders')).body.items[0];
    expect(order).toMatchObject({ status: 'IN_TRANSIT', stockState: 'shipped' });
    expect(await b.level()).toMatchObject({ onHand: 17, reserved: 0 });
    // the same state announced again and again changes nothing
    for (let i = 0; i < 3; i++) await send('IN_TRANSIT');
    await run();
    expect(await b.level()).toMatchObject({ onHand: 17, reserved: 0 });

    // no buyer data anywhere: every text column of every table of this business, and the column names of the new tables
    const leaks = await withAdmin(async (c) =>
      findLeaks(await tenantText(c, b.owner.tenant.id), BUYER_NEEDLES),
    );
    expect(leaks).toEqual([]);
    const columns = await withAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'tiktok\\_%'`,
          )
        ).rows as { table_name: string; column_name: string }[],
    );
    const personal = columns.filter((c) =>
      /name|phone|email|address|buyer|recipient|postal|contact/i.test(c.column_name),
    );
    expect(personal.map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual([
      'tiktok_connections.shop_name', // the seller's own shop name
      'tiktok_sku_links.product_name', // the seller's own product name
    ]);
  });

  it('an access token that expired before the job ran is renewed on the spot, once', async () => {
    const b = await liveBusiness();
    fake.orders.set(
      'EX-1',
      rawOrder({ id: 'EX-1', updateTime: nowSec(), lines: [{ skuId: 'ex', sellerSku: 'X-EX' }] }),
    );
    await withAdmin((c) =>
      c.query(
        `UPDATE tiktok_connections SET access_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [b.connections[0]!.id],
      ),
    );
    const refreshesBefore = fake.refreshes;
    const h = signedTikTokWebhook(
      sampleOrderStatusEvent({
        shopId: b.shops[0]!.id,
        orderId: 'EX-1',
        status: 'AWAITING_SHIPMENT',
        notificationId: `n-${randomUUID()}`,
      }),
      APP_KEY,
      APP_SECRET,
    );
    await t.http.post('/v1/webhooks/tiktok-shop').set(h.headers).send(h.body).expect(200);
    for (const j of queue.pending()) if (j.data['tenantId'] !== b.owner.tenant.id) j.done = true;
    const done = await drain(queue, (job) =>
      processTikTokEvent(b.deps.process, TikTokEventJob.parse(job.data)),
    );
    expect(done.map((d) => d.result)).toEqual([
      { status: 'processed', orderId: expect.any(String) },
    ]);
    expect(fake.refreshes).toBe(refreshesBefore + 1);
    expect(decrypt(b, 'access', (await b.row()).access_token_enc!)).toBe(fake.access);
  });

  it('TikTok refusing the token for good: the event is closed (not retried for ever), the shop needs reconnecting, audited once', async () => {
    const b = await liveBusiness();
    fake.orders.set(
      'TI-1',
      rawOrder({ id: 'TI-1', updateTime: nowSec(), lines: [{ skuId: 'ti', sellerSku: 'X-TI' }] }),
    );
    fake.access = 'ROW_rotated_elsewhere'; // the token we hold is no longer valid at TikTok
    fake.refresh = 'ROW_rotated_too'; // and the refresh token neither
    for (let i = 0; i < 2; i++) {
      const h = signedTikTokWebhook(
        sampleOrderStatusEvent({
          shopId: b.shops[0]!.id,
          orderId: 'TI-1',
          status: 'AWAITING_SHIPMENT',
          notificationId: `n-${randomUUID()}`,
        }),
        APP_KEY,
        APP_SECRET,
      );
      await t.http.post('/v1/webhooks/tiktok-shop').set(h.headers).send(h.body).expect(200);
      for (const j of queue.pending()) if (j.data['tenantId'] !== b.owner.tenant.id) j.done = true;
      const done = await drain(queue, (job) =>
        processTikTokEvent(b.deps.process, TikTokEventJob.parse(job.data)),
      );
      expect(done.map((d) => d.result)).toEqual([{ status: 'ignored', reason: 'token_invalid' }]);
    }
    expect((await b.row()).status).toBe('needs_reconnect');
    expect(await b.audit('integration.needs_attention')).toBe(1);
    const o = (await as(b.owner).get('/v1/integrations/tiktok-shop')).body.connections[0];
    expect(o).toMatchObject({ status: 'needs_reconnect', lastErrorCode: 'token_invalid' });
    expect(o.lastErrorMessage).not.toMatch(/ROW_|token_/);
  });

  it('a rate limit or an outage is retried (the job fails and the event stays received); an unknown order is ignored', async () => {
    const b = await liveBusiness();
    fake.orders.set(
      'RT-1',
      rawOrder({ id: 'RT-1', updateTime: nowSec(), lines: [{ skuId: 'rt', sellerSku: 'X-RT' }] }),
    );
    const h = signedTikTokWebhook(
      sampleOrderStatusEvent({
        shopId: b.shops[0]!.id,
        orderId: 'RT-1',
        status: 'AWAITING_SHIPMENT',
        notificationId: `n-${randomUUID()}`,
      }),
      APP_KEY,
      APP_SECRET,
    );
    await t.http.post('/v1/webhooks/tiktok-shop').set(h.headers).send(h.body).expect(200);
    for (const j of queue.pending()) if (j.data['tenantId'] !== b.owner.tenant.id) j.done = true;
    fake.fail['orders'] = { status: 429, code: 429, message: 'too many requests' };
    const first = await drain(queue, (job) =>
      processTikTokEvent(b.deps.process, TikTokEventJob.parse(job.data)),
    );
    expect(first[0]!.error).toBeInstanceOf(TikTokApiError);
    expect((first[0]!.error as TikTokApiError).kind).toBe('rate_limited');
    expect(await b.orderRows()).toEqual([]);
    fake.fail['orders'] = undefined;
    const second = await drain(queue, (job) =>
      processTikTokEvent(b.deps.process, TikTokEventJob.parse(job.data)),
    );
    expect(second.map((d) => d.result)).toEqual([
      { status: 'processed', orderId: expect.any(String) },
    ]);

    const ghost = signedTikTokWebhook(
      sampleOrderStatusEvent({
        shopId: b.shops[0]!.id,
        orderId: 'NOPE-1',
        status: 'AWAITING_SHIPMENT',
        notificationId: `n-${randomUUID()}`,
      }),
      APP_KEY,
      APP_SECRET,
    );
    await t.http.post('/v1/webhooks/tiktok-shop').set(ghost.headers).send(ghost.body).expect(200);
    for (const j of queue.pending()) if (j.data['tenantId'] !== b.owner.tenant.id) j.done = true;
    const done = await drain(queue, (job) =>
      processTikTokEvent(b.deps.process, TikTokEventJob.parse(job.data)),
    );
    expect(done.map((d) => d.result)).toEqual([{ status: 'ignored', reason: 'order_not_found' }]);
  });
});

describe('the token lifecycle', () => {
  it('renewing replaces BOTH tokens and the expiry; the old refresh token stops working; nothing is logged', async () => {
    const b = await liveBusiness();
    const before = await b.row();
    const oldRefresh = fake.refresh;
    await b.makeDue();
    const r = await refreshDueTikTokTokens(b.deps.sync);
    expect(r.refreshed).toBe(1);
    expect(fake.refreshes).toBe(1);
    const after = await b.row();
    expect(after.access_token_enc).not.toBe(before.access_token_enc);
    expect(after.refresh_token_enc).not.toBe(before.refresh_token_enc);
    expect(decrypt(b, 'access', after.access_token_enc!)).toBe(fake.access);
    expect(decrypt(b, 'refresh', after.refresh_token_enc!)).toBe(fake.refresh);
    expect(fake.refresh).not.toBe(oldRefresh);
    expect(after.refresh_failures).toBe(0);
    expect(after.next_refresh_at).toBeNull();
    expect(new Date(after.access_expires_at as unknown as string).getTime()).toBeGreaterThan(
      Date.now() + 9 * 86_400_000,
    );
    expect(Math.floor(fake.accessExpiresAt.getTime() / 1000)).toBe(
      Math.floor(new Date(after.access_expires_at as unknown as string).getTime() / 1000),
    );
    // the sealed refresh token was used once: using the OLD one again is refused by TikTok
    expect(
      await fake
        .fetch(
          `${AUTH_HOST}/api/v2/token/refresh?app_key=${APP_KEY}&app_secret=${APP_SECRET}&grant_type=refresh_token&refresh_token=${oldRefresh}`,
        )
        .then((x) => x.json()),
    ).toMatchObject({ code: 36004003 });
    expect(logs.join('\n')).not.toContain(fake.refresh);
  });

  it('reads the expiry as seconds when TikTok sends a duration instead of a timestamp', async () => {
    fake.expiresAsDuration = true;
    const b = await liveBusiness();
    const r = await b.row();
    const ms = new Date(r.access_expires_at as unknown as string).getTime() - Date.now();
    expect(ms).toBeGreaterThan(9 * 86_400_000);
    expect(ms).toBeLessThan(11 * 86_400_000);
  });

  it('leaves tokens that are not near expiry alone', async () => {
    const b = await liveBusiness();
    const r = await refreshDueTikTokTokens(b.deps.sync);
    expect(r.refreshed).toBe(0);
    expect(fake.refreshes).toBe(0);
    expect(
      await refreshTikTokTokens(b.deps.sync, {
        tenantId: b.owner.tenant.id,
        connectionId: b.connections[0]!.id,
      }),
    ).toBe('skipped');
    expect(fake.refreshes).toBe(0);
  });

  it('two workers (and the inline renewal of a call) never refresh twice: one TikTok call, the rest skip', async () => {
    const b = await liveBusiness();
    await b.makeDue();
    fake.delayMs = 150;
    const ref = { tenantId: b.owner.tenant.id, connectionId: b.connections[0]!.id };
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => refreshTikTokTokens(b.deps.sync, ref)),
    );
    expect(fake.refreshes).toBe(1);
    expect(outcomes.filter((o) => o === 'refreshed')).toHaveLength(1);
    expect(
      outcomes.filter((o) => o !== 'refreshed').every((o) => o === 'locked' || o === 'skipped'),
    ).toBe(true);
    expect(decrypt(b, 'access', (await b.row()).access_token_enc!)).toBe(fake.access);
    fake.delayMs = 0;
  });

  it('shops authorised together share one pair: one call renews them all, in one transaction', async () => {
    const b = await liveBusiness({ shops: 2 });
    await Promise.all(b.connections.map((c) => b.makeDue(c.id)));
    const r = await refreshDueTikTokTokens(b.deps.sync);
    expect(r.refreshed).toBe(1);
    expect(fake.refreshes).toBe(1);
    const [one, two] = await Promise.all(b.connections.map((c) => b.row(c.id)));
    expect(one!.access_token_enc).toBe(two!.access_token_enc);
    expect(decrypt(b, 'access', one!.access_token_enc!)).toBe(fake.access);
    expect(decrypt(b, 'refresh', two!.refresh_token_enc!)).toBe(fake.refresh);
  });

  it('a failure keeps the old tokens and backs off (15 minutes, then 30), and success resets it', async () => {
    const b = await liveBusiness();
    const id = b.connections[0]!.id;
    const ref = { tenantId: b.owner.tenant.id, connectionId: id };
    await b.makeDue();
    const sealed = await b.row();
    fake.fail['refresh'] = { status: 500, code: 500, message: 'oops' };
    expect(await refreshTikTokTokens(b.deps.sync, ref)).toBe('failed');
    let r = await b.row();
    expect(r.access_token_enc).toBe(sealed.access_token_enc);
    expect(r.refresh_token_enc).toBe(sealed.refresh_token_enc);
    expect(r.status).toBe('active');
    expect(r.refresh_failures).toBe(1);
    const wait1 = new Date(r.next_refresh_at as unknown as string).getTime() - Date.now();
    expect(wait1).toBeGreaterThan(14 * 60_000);
    expect(wait1).toBeLessThanOrEqual(15 * 60_000);
    // the scan does not retry inside the back-off
    const calls = fake.refreshes;
    expect((await refreshDueTikTokTokens(b.deps.sync)).refreshed).toBe(0);
    expect(fake.refreshes).toBe(calls);
    // after it, it tries again and fails again: twice as long
    await withAdmin((c) =>
      c.query(
        `UPDATE tiktok_connections SET next_refresh_at = now() - interval '1 minute' WHERE id = $1`,
        [id],
      ),
    );
    expect(await refreshTikTokTokens(b.deps.sync, ref)).toBe('failed');
    r = await b.row();
    expect(r.refresh_failures).toBe(2);
    const wait2 = new Date(r.next_refresh_at as unknown as string).getTime() - Date.now();
    expect(wait2).toBeGreaterThan(29 * 60_000);
    // then it works
    fake.fail['refresh'] = undefined;
    await withAdmin((c) =>
      c.query(`UPDATE tiktok_connections SET next_refresh_at = NULL WHERE id = $1`, [id]),
    );
    expect(await refreshTikTokTokens(b.deps.sync, ref)).toBe('refreshed');
    r = await b.row();
    expect([r.refresh_failures, r.next_refresh_at]).toEqual([0, null]);
    expect(counts.refresh['failed']).toBeGreaterThanOrEqual(2);
  });

  it('a refresh token TikTok no longer accepts marks every shop of the grant needs_reconnect, keeps the tokens, audits once, and the scan stops trying', async () => {
    const b = await liveBusiness({ shops: 2 });
    await Promise.all(b.connections.map((c) => b.makeDue(c.id)));
    fake.refresh = 'ROW_someone_else_refreshed';
    expect(
      await refreshTikTokTokens(b.deps.sync, {
        tenantId: b.owner.tenant.id,
        connectionId: b.connections[0]!.id,
      }),
    ).toBe('needs_reconnect');
    for (const c of b.connections) {
      const r = await b.row(c.id);
      expect(r.status).toBe('needs_reconnect');
      expect(r.refresh_token_enc).toBeTruthy();
      expect(r['last_error_code']).toBe('token_invalid');
    }
    expect(await b.audit('integration.needs_attention')).toBe(1);
    const calls = fake.refreshes;
    expect((await refreshDueTikTokTokens(b.deps.sync)).refreshed).toBe(0);
    expect(fake.refreshes).toBe(calls);
    expect(
      await refreshTikTokTokens(b.deps.sync, {
        tenantId: b.owner.tenant.id,
        connectionId: b.connections[0]!.id,
      }),
    ).toBe('skipped');
  });

  it('a permission error on renewal marks permission_error', async () => {
    const b = await liveBusiness();
    await b.makeDue();
    fake.fail['refresh'] = {
      status: 403,
      code: 105005,
      message: 'permission denied for this scope',
    };
    expect(
      await refreshTikTokTokens(b.deps.sync, {
        tenantId: b.owner.tenant.id,
        connectionId: b.connections[0]!.id,
      }),
    ).toBe('permission_error');
    expect((await b.row()).status).toBe('permission_error');
  });

  it('clock-driven expiry: a call made after the access token expired renews it first and succeeds', async () => {
    const b = await liveBusiness({
      orders: [
        rawOrder({
          id: 'CK-1',
          updateTime: nowSec() - 60,
          lines: [{ skuId: 'ck', sellerSku: 'X-CK' }],
        }),
      ],
    });
    await withAdmin((c) =>
      c.query(
        `UPDATE tiktok_connections SET access_expires_at = now() - interval '2 hours', last_synced_at = now() - interval '1 hour' WHERE id = $1`,
        [b.connections[0]!.id],
      ),
    );
    const before = fake.refreshes;
    const r = await syncTikTokConnection(b.deps.sync, {
      tenantId: b.owner.tenant.id,
      connectionId: b.connections[0]!.id,
    });
    expect(fake.refreshes).toBe(before + 1);
    expect(r.fetched).toBeGreaterThanOrEqual(1);
    expect((await b.row()).status).toBe('active');
  });

  it('a token TikTok invalidated while ours still looked valid: one forced renewal, the call is repeated once and succeeds', async () => {
    const b = await liveBusiness();
    fake.orders.set(
      'IV-1',
      rawOrder({
        id: 'IV-1',
        updateTime: nowSec() - 60,
        lines: [{ skuId: 'iv', sellerSku: 'X-IV' }],
      }),
    );
    fake.access = 'ROW_invalidated_remotely'; // the refresh token is still good, so renewal can recover
    const before = fake.refreshes;
    const r = await syncTikTokConnection(b.deps.sync, {
      tenantId: b.owner.tenant.id,
      connectionId: b.connections[0]!.id,
    });
    expect(fake.refreshes).toBe(before + 1);
    expect(r.updated).toBe(1);
    expect((await b.row()).status).toBe('active');
  });
});

describe('the catch-up check', () => {
  it('fills in an order whose webhook was lost, once, and advances the clock it reads from', async () => {
    const b = await liveBusiness();
    const sku = (await as(b.owner).get(`/v1/inventory?variantId=${b.variant.id}`)).body.items[0]
      .sku as string;
    fake.orders.set(
      'MS-1',
      rawOrder({
        id: 'MS-1',
        status: 'AWAITING_SHIPMENT',
        updateTime: nowSec() - 300,
        lines: [{ skuId: 'ms', sellerSku: sku, units: 4 }],
      }),
    );
    const ref = { tenantId: b.owner.tenant.id, connectionId: b.connections[0]!.id };
    const r = await syncTikTokConnection(b.deps.sync, ref);
    expect(r).toMatchObject({ fetched: 1, updated: 1, truncated: false });
    expect((await b.orderRows())[0]).toMatchObject({
      external_order_id: 'MS-1',
      stock_state: 'reserved',
    });
    expect(await b.level()).toMatchObject({ reserved: 4 });
    const synced = new Date((await b.row()).last_synced_at as unknown as string).getTime();
    expect(synced).toBeGreaterThan(Date.now() - 60_000);
    // the same orders are read again (the overlap) and nothing happens twice
    const again = await syncTikTokConnection(b.deps.sync, ref);
    expect(again.fetched).toBe(1);
    expect(await b.level()).toMatchObject({ reserved: 4 });
    // it asked TikTok for the window since the last check with the overlap
    const search = fake.called('/orders/search').at(-1)!;
    const body = JSON.parse(search.body!) as { update_time_ge: number };
    expect(body.update_time_ge).toBeLessThanOrEqual(Math.floor(synced / 1000) - 9 * 60);
    expect(search.query.get('sort_order')).toBe('ASC');
    // and a later status is picked up the same way
    fake.orders.set(
      'MS-1',
      rawOrder({
        id: 'MS-1',
        status: 'IN_TRANSIT',
        updateTime: nowSec(),
        lines: [{ skuId: 'ms', sellerSku: sku, units: 4 }],
      }),
    );
    await syncTikTokConnection(b.deps.sync, ref);
    expect(await b.level()).toMatchObject({ onHand: 16, reserved: 0 });
  });

  it('reads orders in full when the search answers only ids', async () => {
    const b = await liveBusiness();
    fake.searchIdsOnly = true;
    fake.orders.set(
      'ID-1',
      rawOrder({
        id: 'ID-1',
        updateTime: nowSec() - 100,
        lines: [{ skuId: 'id', sellerSku: 'X-ID' }],
      }),
    );
    const r = await syncTikTokConnection(b.deps.sync, {
      tenantId: b.owner.tenant.id,
      connectionId: b.connections[0]!.id,
    });
    expect(r.updated).toBe(1);
    expect(fake.called('/order/202309/orders').filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('backs off when TikTok limits requests (1 s, then 3 s) and gives up quietly after that, leaving last_synced_at alone', async () => {
    const b = await liveBusiness();
    fake.orders.set(
      'RL-1',
      rawOrder({
        id: 'RL-1',
        updateTime: nowSec() - 100,
        lines: [{ skuId: 'rl', sellerSku: 'X-RL' }],
      }),
    );
    const sleeps: number[] = [];
    const deps = workerDeps(t, fake, { now, metrics, sleeps });
    const ref = { tenantId: b.owner.tenant.id, connectionId: b.connections[0]!.id };
    const before = (await b.row()).last_synced_at;
    fake.rateLimitSearch = 2;
    const ok = await syncTikTokConnection(deps.sync, ref);
    expect(sleeps).toEqual([1000, 3000]);
    expect(ok.updated).toBe(1);
    sleeps.length = 0;
    fake.rateLimitSearch = 5;
    const lastSynced = (await b.row()).last_synced_at;
    const gaveUp = await syncTikTokConnection(deps.sync, ref);
    expect(sleeps).toEqual([1000, 3000]);
    expect(gaveUp.fetched).toBe(0);
    expect((await b.row()).last_synced_at).toEqual(lastSynced);
    expect(before).toBeTruthy();
  });

  it('reads a backlog over several runs, oldest change first, never skipping an order', async () => {
    const b = await liveBusiness();
    fake.pageSize = 1;
    const base = nowSec() - 3600;
    for (let i = 0; i < 12; i++)
      fake.orders.set(
        `BK-${String(i).padStart(2, '0')}`,
        rawOrder({
          id: `BK-${String(i).padStart(2, '0')}`,
          updateTime: base + i * 10,
          lines: [{ skuId: `bk-${i}`, sellerSku: `X-BK-${i}` }],
        }),
      );
    const ref = { tenantId: b.owner.tenant.id, connectionId: b.connections[0]!.id };
    await withAdmin((c) =>
      c.query(
        `UPDATE tiktok_connections SET last_synced_at = now() - interval '2 hours' WHERE id = $1`,
        [ref.connectionId],
      ),
    );
    const first = await syncTikTokConnection(b.deps.sync, ref);
    expect(first).toMatchObject({ fetched: 10, truncated: true });
    const midway = new Date((await b.row()).last_synced_at as unknown as string).getTime();
    expect(midway).toBeLessThan(Date.now() - 30 * 60_000); // only as far as it really got
    const second = await syncTikTokConnection(b.deps.sync, ref);
    expect(second.truncated).toBe(false);
    expect((await b.orderRows()).map((o) => o.external_order_id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `BK-${String(i).padStart(2, '0')}`),
    );
  });

  it('a refused token found on the way marks the shop and the manual sync answers tiktok_token_invalid', async () => {
    const b = await liveBusiness();
    fake.access = 'ROW_x';
    fake.refresh = 'ROW_y';
    const res = await as(b.owner).post(
      `/v1/integrations/tiktok-shop/connections/${b.connections[0]!.id}/sync`,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('tiktok_token_invalid');
    expect((await b.row()).status).toBe('needs_reconnect');
    // a connection that needs reconnecting is not polled any more
    const calls = fake.calls.length;
    await syncTikTokConnection(b.deps.sync, {
      tenantId: b.owner.tenant.id,
      connectionId: b.connections[0]!.id,
    });
    expect(fake.calls.length).toBe(calls);
  });

  it('the manual sync answers what it found', async () => {
    const b = await liveBusiness();
    fake.orders.set(
      'MN-1',
      rawOrder({
        id: 'MN-1',
        updateTime: nowSec() - 100,
        lines: [{ skuId: 'mn', sellerSku: 'X-MN' }],
      }),
    );
    const res = await as(b.owner)
      .post(`/v1/integrations/tiktok-shop/connections/${b.connections[0]!.id}/sync`)
      .expect(200);
    expect(res.body).toMatchObject({ mode: 'live', fetched: 1, updated: 1, truncated: false });
  });
});

describe('connection health', () => {
  it('marks a refused token needs_reconnect (audited once), a shop that is no longer authorised permission_error, and recovers', async () => {
    const b = await liveBusiness();
    const ref = { tenantId: b.owner.tenant.id, connectionId: b.connections[0]!.id };
    expect(await checkTikTokConnectionHealth(b.deps.sync, ref)).toBe('ok');
    expect((await b.row()).status).toBe('active');

    const removed = fake.shops.splice(0, fake.shops.length);
    expect(await checkTikTokConnectionHealth(b.deps.sync, ref)).toBe('permission_error');
    expect((await b.row()).status).toBe('permission_error');
    fake.shops.push(...removed);
    expect(await checkTikTokConnectionHealth(b.deps.sync, ref)).toBe('ok');
    expect((await b.row()).status).toBe('active');

    fake.access = 'ROW_dead';
    fake.refresh = 'ROW_dead_too';
    expect(await checkTikTokConnectionHealth(b.deps.sync, ref)).toBe('needs_reconnect');
    expect(await b.audit('integration.needs_attention')).toBe(2); // permission_error, then needs_reconnect
    expect(await checkTikTokConnectionHealth(b.deps.sync, ref)).toBe('needs_reconnect');
    expect(await b.audit('integration.needs_attention')).toBe(2);
  });

  it('an outage changes nothing; the sweep covers every live connection and never stops on one failure', async () => {
    const b = await liveBusiness();
    fake.fail['shops'] = { status: 503, code: 503, message: 'down' };
    expect(
      await checkTikTokConnectionHealth(b.deps.sync, {
        tenantId: b.owner.tenant.id,
        connectionId: b.connections[0]!.id,
      }),
    ).toBe('unreachable');
    expect((await b.row()).status).toBe('active');
    fake.fail['shops'] = undefined;
    const swept = await runTikTokHealthSweep(b.deps.sync);
    expect(swept.ok).toBeGreaterThanOrEqual(1);
    expect(
      await checkTikTokConnectionHealth(b.deps.sync, {
        tenantId: b.owner.tenant.id,
        connectionId: randomUUID(),
      }),
    ).toBe('skipped');
  });
});

describe('retention', () => {
  it('deletes old events, old final orders without a live reservation, and expired hand-overs; keeps everything else', async () => {
    const b = await liveBusiness();
    const tenantId = b.owner.tenant.id;
    const connectionId = b.connections[0]!.id;
    const ev = (key: string, status: string, ageDays: number) =>
      withAdmin((c) =>
        c.query(
          `INSERT INTO tiktok_events (id, tenant_id, connection_id, external_event_id, event_type, event_timestamp, status, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'order_status', now(), $4::"TikTokEventStatus", now() - make_interval(days => $5))`,
          [tenantId, connectionId, key, status, ageDays],
        ),
      );
    await ev('old-processed', 'processed', 31);
    await ev('old-ignored', 'ignored', 40);
    await ev('old-received', 'received', 40); // still waiting to be processed: kept
    await ev('recent', 'processed', 29);
    const order = (id: string, status: string, ageDays: number) =>
      withAdmin((c) =>
        c.query(
          `INSERT INTO tiktok_orders (id, tenant_id, connection_id, external_order_id, status, currency, updated_at, status_updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'MYR', now() - make_interval(days => $5), now() - make_interval(days => $5))`,
          [tenantId, connectionId, id, status, ageDays],
        ),
      );
    await order('o-old-completed', 'COMPLETED', 200);
    await order('o-old-cancelled', 'CANCELLED', 200);
    await order('o-old-delivered', 'DELIVERED', 200);
    await order('o-old-inflight', 'IN_TRANSIT', 200); // not final: kept
    await order('o-recent-completed', 'COMPLETED', 100); // inside the 180 days: kept
    await order('o-old-held', 'COMPLETED', 200); // final and old, but still holds a reservation: kept
    const hashOld = `h-old-${randomUUID()}`;
    const hashNew = `h-new-${randomUUID()}`;
    const reservationId = await withAdmin(async (c) => {
      const loc = (
        await c.query(`SELECT id FROM stock_locations WHERE tenant_id = $1 LIMIT 1`, [tenantId])
      ).rows[0].id;
      const res = (
        await c.query(
          `INSERT INTO reservations (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id) VALUES (gen_random_uuid(), $1, $2, $3, 1, 'tiktok_order', 'x') RETURNING id`,
          [tenantId, b.variant.id, loc],
        )
      ).rows[0].id as string;
      await c.query(
        `UPDATE stock_levels SET reserved = reserved + 1 WHERE tenant_id = $1 AND variant_id = $2`,
        [tenantId, b.variant.id],
      );
      await c.query(
        `INSERT INTO tiktok_stock_holds (id, tenant_id, tiktok_order_id, line_key, variant_id, quantity, reservation_id, state, updated_at)
         SELECT gen_random_uuid(), $1, o.id, 'sku:h', $2, 1, $3, 'held', now() FROM tiktok_orders o WHERE o.tenant_id = $1 AND o.external_order_id = 'o-old-held'`,
        [tenantId, b.variant.id, res],
      );
      await c.query(
        `INSERT INTO tiktok_oauth_sessions (id, tenant_id, user_id, state_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '3 days'), (gen_random_uuid(), $1, $2, $4, now() + interval '5 minutes')`,
        [tenantId, b.owner.user.id, hashOld, hashNew],
      );
      return res;
    });
    expect(reservationId).toBeTruthy();
    const r = await purgeTikTokData({ db: t.db, orderRetentionDays: 180, log: () => undefined });
    expect(r.events).toBeGreaterThanOrEqual(2);
    expect(r.orders).toBeGreaterThanOrEqual(3);
    expect(r.sessions).toBeGreaterThanOrEqual(1);
    const left = await withAdmin(async (c) => ({
      events: (
        await c.query(
          `SELECT external_event_id FROM tiktok_events WHERE connection_id = $1 AND external_event_id IN ('old-processed','old-ignored','old-received','recent') ORDER BY 1`,
          [connectionId],
        )
      ).rows.map((x) => x.external_event_id as string),
      orders: (
        await c.query(
          `SELECT external_order_id FROM tiktok_orders WHERE tenant_id = $1 AND external_order_id LIKE 'o-%' ORDER BY 1`,
          [tenantId],
        )
      ).rows.map((x) => x.external_order_id as string),
      sessions: (
        await c.query(
          `SELECT state_hash FROM tiktok_oauth_sessions WHERE tenant_id = $1 ORDER BY 1`,
          [tenantId],
        )
      ).rows.map((x) => x.state_hash as string),
    }));
    expect(left.events).toEqual(['old-received', 'recent']);
    expect(left.orders).toEqual(['o-old-held', 'o-old-inflight', 'o-recent-completed']);
    expect(left.sessions).toContain(hashNew);
    expect(left.sessions).not.toContain(hashOld);
    // repeating it is harmless
    expect(
      await purgeTikTokData({ db: t.db, orderRetentionDays: 180, log: () => undefined }),
    ).toMatchObject({ orders: expect.any(Number) });
    // a configurable window is never shorter than 30 days, whatever is asked
    await order('o-30', 'COMPLETED', 20);
    await t.db.purgeTikTokData(30, 1);
    expect(
      (await withAdmin(
        async (c) =>
          (
            await c.query(
              `SELECT count(*)::int n FROM tiktok_orders WHERE tenant_id = $1 AND external_order_id = 'o-30'`,
              [tenantId],
            )
          ).rows[0].n,
      )) as number,
    ).toBe(1);
  });
});

describe('tenant isolation', () => {
  it('another business sees none of it and cannot act on it', async () => {
    const a = await liveBusiness({
      orders: [
        rawOrder({
          id: 'IS-1',
          updateTime: nowSec() - 60,
          lines: [{ skuId: 'is', sellerSku: 'X-IS' }],
        }),
      ],
    });
    const other = await registerTenant(t);
    const o = as(other);
    expect((await o.get('/v1/integrations/tiktok-shop').expect(200)).body.connections).toEqual([]);
    expect((await o.get('/v1/tiktok-orders').expect(200)).body.items).toEqual([]);
    expect((await o.get('/v1/tiktok-sku-links').expect(200)).body.items).toEqual([]);
    const link = (await as(a.owner).get('/v1/tiktok-sku-links').expect(200)).body.items[0];
    expect((await o.put(`/v1/tiktok-sku-links/${link.id}`, { variantId: null })).status).toBe(404);
    const id = a.connections[0]!.id;
    expect((await o.del(`/v1/integrations/tiktok-shop/connections/${id}`)).status).toBe(404);
    expect((await o.post(`/v1/integrations/tiktok-shop/connections/${id}/sync`)).status).toBe(404);
    expect((await o.post(`/v1/integrations/tiktok-shop/connections/${id}/reconnect`)).status).toBe(
      404,
    );
    expect((await a.row()).status).toBe('active');
  });
});

describe('metrics', () => {
  it('count events, renewals and reconciliations with fixed labels only: no shop, order, business or token in any label', async () => {
    const text = await t.app.get(MetricsService).registry.render();
    for (const name of [
      'orderloop_tiktok_events_total',
      'orderloop_tiktok_token_refresh_total',
      'orderloop_tiktok_reconcile_total',
    ])
      expect(text, name).toContain(`# TYPE ${name} counter`);
    const series = text
      .split('\n')
      .filter((l) => l.startsWith('orderloop_tiktok_') && !l.startsWith('#'));
    expect(series.length).toBeGreaterThan(0);
    for (const line of series) {
      expect(line).toMatch(
        /^orderloop_tiktok_(events|token_refresh|reconcile)_total\{(result|outcome)="[a-z_]+"\} \d+$/,
      );
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|mock_|ROW_/);
    }
    expect(text).toContain('result="stored"');
  });
});
