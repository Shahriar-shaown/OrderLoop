import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, PASSWORD, uniqueEmail, type TestApp } from './app.js';

/**
 * "Check it like a user": the checkpoint flows exercised the way a real client does, over real HTTP against a
 * listening server, using plain fetch (no supertest, no in-process shortcuts, no helpers that hide a step).
 *
 *   register -> reach a protected endpoint -> refresh the session securely -> log out
 *
 * Two users: a native app (tokens in JSON) and a browser (refresh token in an HttpOnly cookie).
 */
let t: TestApp;
let base: string;

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen(0);
  base = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(() => t.close());

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : {}) as Json };
}

describe('journey 1: a native app user', () => {
  const email = uniqueEmail('journey');
  let phone: Json; // the session created by registering
  let tablet: Json; // a second device, signed in later

  it('1. registers a new account and workspace and is signed straight in', async () => {
    const res = await call('POST', '/v1/auth/register', {
      body: { email, password: PASSWORD, name: 'Journey User', tenantName: 'Journey Shop' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      role: 'OWNER',
      tenant: { name: 'Journey Shop' },
      user: { email, emailVerified: false },
    });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    phone = res.body;
  });

  it('2. is turned away from a protected endpoint without a token, with a clear error', async () => {
    const res = await call('GET', '/v1/me');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 401, code: 'unauthorized' });
    expect((await call('GET', '/v1/me', { token: 'not.a.token' })).status).toBe(401);
  });

  it('3. reaches the protected endpoint with the access token and sees their own data', async () => {
    const res = await call('GET', '/v1/me', { token: phone.accessToken });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user: { email },
      tenant: { name: 'Journey Shop' },
      role: 'OWNER',
    });
    expect(res.body.permissions.length).toBeGreaterThan(0);
  });

  it('4. cannot sign in with the wrong password, but can with the right one (second device)', async () => {
    const wrong = await call('POST', '/v1/auth/login', {
      body: { email, password: 'definitely not the password' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('invalid_credentials');

    const ok = await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect(ok.body.tenant.name).toBe('Journey Shop');
    tablet = ok.body;
    expect((await call('GET', '/v1/me', { token: tablet.accessToken })).status).toBe(200);
  });

  it('5. refreshes the session: gets a new access and refresh token, and the new access token works', async () => {
    const res = await call('POST', '/v1/auth/refresh', {
      body: { refreshToken: tablet.refreshToken },
    });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(tablet.refreshToken);
    expect(res.body.accessToken).not.toBe(tablet.accessToken);
    expect((await call('GET', '/v1/me', { token: res.body.accessToken })).status).toBe(200);
    tablet = { ...tablet, previousRefresh: tablet.refreshToken, ...res.body };
  });

  it('6. a stolen, already-used refresh token is refused and ends that session, but not the other device', async () => {
    const replay = await call('POST', '/v1/auth/refresh', {
      body: { refreshToken: tablet.previousRefresh },
    });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('token_reuse_detected');

    // The tablet's session is dead everywhere: even its newest tokens no longer work.
    expect(
      (await call('POST', '/v1/auth/refresh', { body: { refreshToken: tablet.refreshToken } }))
        .status,
    ).toBe(401);
    expect((await call('GET', '/v1/me', { token: tablet.accessToken })).status).toBe(401);
    // The phone is a separate session and is unaffected.
    expect((await call('GET', '/v1/me', { token: phone.accessToken })).status).toBe(200);
  });

  it('7. logs out: the access token and the refresh token both stop working immediately', async () => {
    expect((await call('POST', '/v1/auth/logout', { token: phone.accessToken })).status).toBe(200);

    const me = await call('GET', '/v1/me', { token: phone.accessToken });
    expect(me.status).toBe(401);
    const refresh = await call('POST', '/v1/auth/refresh', {
      body: { refreshToken: phone.refreshToken },
    });
    expect(refresh.status).toBe(401);
  });

  it('8. can sign back in after logging out', async () => {
    const res = await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(res.status).toBe(200);
    expect((await call('GET', '/v1/me', { token: res.body.accessToken })).status).toBe(200);
  });
});

describe('journey 2: a browser user (refresh token in an HttpOnly cookie)', () => {
  const email = uniqueEmail('browser');
  const web = { 'x-client': 'web', origin: 'http://localhost:3000' };
  /** A minimal cookie jar: remembers the latest ol_rt value, as a browser would. */
  let cookie = '';
  const remember = (headers: Headers) => {
    const set = headers.getSetCookie().find((c) => c.startsWith('ol_rt='));
    if (set) cookie = set.split(';')[0]!;
    return set;
  };
  let accessToken = '';

  it('1. registers; the refresh token arrives only as an HttpOnly cookie, never in the page-readable JSON', async () => {
    const res = await call('POST', '/v1/auth/register', {
      body: { email, password: PASSWORD, name: 'Browser User', tenantName: 'Browser Shop' },
      headers: web,
    });
    expect(res.status).toBe(201);
    expect(res.body.refreshToken).toBeUndefined();
    const set = remember(res.headers)!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Path=\/v1\/auth/);
    accessToken = res.body.accessToken;
  });

  it('2. reaches a protected endpoint with the access token', async () => {
    const res = await call('GET', '/v1/tenant', { token: accessToken });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Browser Shop');
  });

  it('3. refreshes silently using only the cookie: the cookie rotates and a fresh access token works', async () => {
    const before = cookie;
    const res = await call('POST', '/v1/auth/refresh', { body: {}, headers: { ...web, cookie } });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeUndefined();
    remember(res.headers);
    expect(cookie).not.toBe(before);
    expect(res.body.accessToken).not.toBe(accessToken);
    expect((await call('GET', '/v1/me', { token: res.body.accessToken })).status).toBe(200);
    accessToken = res.body.accessToken;
  });

  it('4. a malicious site cannot ride the cookie: no x-client header is refused, and so is a foreign origin', async () => {
    const noHeader = await call('POST', '/v1/auth/refresh', { body: {}, headers: { cookie } });
    expect(noHeader.status).toBe(401);
    const foreign = await call('POST', '/v1/auth/refresh', {
      body: {},
      headers: { 'x-client': 'web', origin: 'https://evil.example', cookie },
    });
    expect(foreign.status).toBe(403);
    // Those failed attempts did not burn the legitimate cookie.
    expect(
      (await call('POST', '/v1/auth/refresh', { body: {}, headers: { ...web, cookie } })).status,
    ).toBe(200);
  });

  it('5. logs out: the cookie is cleared and the old cookie can no longer refresh', async () => {
    const stale = cookie;
    const res = await call('POST', '/v1/auth/logout', { token: accessToken, headers: web });
    expect(res.status).toBe(200);
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith('ol_rt='))!;
    expect(cleared).toMatch(/ol_rt=;|Expires=Thu, 01 Jan 1970/i); // the browser is told to delete it

    expect((await call('GET', '/v1/me', { token: accessToken })).status).toBe(401);
    expect(
      (await call('POST', '/v1/auth/refresh', { body: {}, headers: { ...web, cookie: stale } }))
        .status,
    ).toBe(401);
  });
});
