import type { AuthResult } from '@orderloop/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  createTestApp,
  PASSWORD,
  registerTenant,
  uniqueEmail,
  type TestApp,
} from './app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('register', () => {
  it('creates a user and tenant, makes the user OWNER, and issues tokens', async () => {
    const owner = await registerTenant(t, { tenantName: 'Dhaka Threads' });
    expect(owner.role).toBe('OWNER');
    expect(owner.tenant.name).toBe('Dhaka Threads');
    expect(owner.memberships).toEqual([{ tenantId: owner.tenant.id, role: 'OWNER' }]);
    expect(owner.refreshToken).toBeTruthy();

    const me = await t.http.get('/v1/me').set(bearer(owner.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(owner.email);
    expect(me.body.permissions).toContain('members:manage');
  });

  it('never stores the password or refresh token in readable form', async () => {
    const owner = await registerTenant(t);
    const user = await t.db.global.user.findUniqueOrThrow({ where: { email: owner.email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
    const tokens = await t.db.global.refreshToken.findMany({
      where: { session: { userId: user.id } },
    });
    expect(
      tokens.every((r) => r.tokenHash !== owner.refreshToken && r.tokenHash.length === 64),
    ).toBe(true);
  });

  it('rejects a duplicate email (case-insensitive) with 409', async () => {
    const owner = await registerTenant(t);
    const res = await t.http
      .post('/v1/auth/register')
      .send({ email: owner.email.toUpperCase(), password: PASSWORD, name: 'X', tenantName: 'Y' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conflict');
  });

  it('rejects weak input with RFC 9457 problem details and field paths', async () => {
    const res = await t.http
      .post('/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short', name: '', tenantName: 'ok' });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 400, code: 'validation_failed' });
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(
      expect.arrayContaining(['body.email', 'body.password', 'body.name']),
    );
  });
});

describe('login', () => {
  it('signs in with the right password', async () => {
    const owner = await registerTenant(t);
    const res = await t.http
      .post('/v1/auth/login')
      .send({ email: owner.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.tenant.id).toBe(owner.tenant.id);
  });

  it('gives identical answers for unknown email and wrong password (no user enumeration)', async () => {
    const owner = await registerTenant(t);
    const wrong = await t.http
      .post('/v1/auth/login')
      .send({ email: owner.email, password: 'definitely wrong' });
    const unknown = await t.http
      .post('/v1/auth/login')
      .send({ email: uniqueEmail('ghost'), password: 'definitely wrong' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.code).toBe('invalid_credentials');
  });

  it('locks the account after five failures, even for the correct password', async () => {
    const owner = await registerTenant(t);
    for (let i = 0; i < 5; i++)
      await t.http
        .post('/v1/auth/login')
        .send({ email: owner.email, password: 'wrong-wrong-wrong' });
    const locked = await t.http
      .post('/v1/auth/login')
      .send({ email: owner.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('rate_limited');
  });

  it('a successful login resets the failure counter', async () => {
    const owner = await registerTenant(t);
    for (let i = 0; i < 3; i++)
      await t.http
        .post('/v1/auth/login')
        .send({ email: owner.email, password: 'wrong-wrong-wrong' });
    expect(
      (await t.http.post('/v1/auth/login').send({ email: owner.email, password: PASSWORD })).status,
    ).toBe(200);
    for (let i = 0; i < 3; i++)
      await t.http
        .post('/v1/auth/login')
        .send({ email: owner.email, password: 'wrong-wrong-wrong' });
    expect(
      (await t.http.post('/v1/auth/login').send({ email: owner.email, password: PASSWORD })).status,
    ).toBe(200);
  });
});

describe('access control basics', () => {
  it('rejects a missing or malformed bearer token with 401 problem details', async () => {
    const none = await t.http.get('/v1/me');
    expect(none.status).toBe(401);
    expect(none.headers['content-type']).toMatch(/problem\+json/);
    expect((await t.http.get('/v1/me').set(bearer('garbage'))).status).toBe(401);
  });

  it('public endpoints need no token', async () => {
    expect((await t.http.get('/health/live')).status).toBe(200);
    expect((await t.http.get('/openapi.json')).body.openapi).toBe('3.1.0');
  });
});

describe('disabled accounts', () => {
  it('lose access immediately: existing access token, refresh token and login all fail', async () => {
    const owner = await registerTenant(t);
    expect((await t.http.get('/v1/me').set(bearer(owner.accessToken))).status).toBe(200);
    await t.db.global.user.update({
      where: { email: owner.email },
      data: { disabledAt: new Date() },
    });
    expect((await t.http.get('/v1/me').set(bearer(owner.accessToken))).status).toBe(401);
    expect(
      (await t.http.post('/v1/auth/refresh').send({ refreshToken: owner.refreshToken })).status,
    ).toBe(401);
    expect(
      (await t.http.post('/v1/auth/login').send({ email: owner.email, password: PASSWORD })).status,
    ).toBe(401);
  });
});

describe('refresh token rotation', () => {
  it('issues a new refresh token each time and the old one stops working', async () => {
    const owner = await registerTenant(t);
    const first = await t.http.post('/v1/auth/refresh').send({ refreshToken: owner.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).toBeTruthy();
    expect(first.body.refreshToken).not.toBe(owner.refreshToken);
    expect((await t.http.get('/v1/me').set(bearer(first.body.accessToken))).status).toBe(200);
  });

  it('detects replay of a used token and revokes the whole session, including the newer token', async () => {
    const owner = await registerTenant(t);
    const rotated = (
      await t.http.post('/v1/auth/refresh').send({ refreshToken: owner.refreshToken })
    ).body as AuthResult & { refreshToken: string };

    const replay = await t.http.post('/v1/auth/refresh').send({ refreshToken: owner.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('token_reuse_detected');

    // The thief and the legitimate user are both locked out: the descendant token and its access token die too.
    expect(
      (await t.http.post('/v1/auth/refresh').send({ refreshToken: rotated.refreshToken })).status,
    ).toBe(401);
    expect((await t.http.get('/v1/me').set(bearer(rotated.accessToken))).status).toBe(401);

    const session = await t.db.global.session.findFirstOrThrow({
      where: { user: { email: owner.email } },
    });
    expect(session.revokedReason).toBe('refresh_token_reuse');
  });

  it('of two concurrent exchanges of one token, exactly one succeeds', async () => {
    const owner = await registerTenant(t);
    const results = await Promise.all(
      [1, 2].map(() => t.http.post('/v1/auth/refresh').send({ refreshToken: owner.refreshToken })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('rejects an expired refresh token and an unknown one', async () => {
    const owner = await registerTenant(t);
    await t.db.global.refreshToken.updateMany({
      where: { session: { user: { email: owner.email } } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: owner.refreshToken });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('token_expired');
    expect(
      (await t.http.post('/v1/auth/refresh').send({ refreshToken: 'never-issued' })).status,
    ).toBe(401);
  });

  it('requires a token when none is provided', async () => {
    expect((await t.http.post('/v1/auth/refresh').send({})).status).toBe(401);
  });
});

describe('logout', () => {
  it('revokes the session immediately: access and refresh tokens both stop working', async () => {
    const owner = await registerTenant(t);
    expect((await t.http.post('/v1/auth/logout').set(bearer(owner.accessToken))).status).toBe(200);
    expect((await t.http.get('/v1/me').set(bearer(owner.accessToken))).status).toBe(401);
    expect(
      (await t.http.post('/v1/auth/refresh').send({ refreshToken: owner.refreshToken })).status,
    ).toBe(401);
  });
});

describe('web client (cookie transport)', () => {
  it('delivers the refresh token as an HttpOnly cookie and never in the body', async () => {
    const email = uniqueEmail('web');
    const res = await t.http
      .post('/v1/auth/register')
      .set('x-client', 'web')
      .send({ email, password: PASSWORD, name: 'Web', tenantName: 'Web Shop' });
    expect(res.status).toBe(201);
    expect(res.body.refreshToken).toBeUndefined();
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('ol_rt='),
    )!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/v1\/auth/);

    const refreshed = await t.http
      .post('/v1/auth/refresh')
      .set('x-client', 'web')
      .set('Cookie', cookie.split(';')[0]!)
      .set('Origin', 'http://localhost:3000')
      .send({});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();
  });

  it('ignores the cookie without the x-client header, and rejects a foreign Origin', async () => {
    const email = uniqueEmail('web2');
    const res = await t.http
      .post('/v1/auth/register')
      .set('x-client', 'web')
      .send({ email, password: PASSWORD, name: 'Web', tenantName: 'Web Shop' });
    const cookie = (res.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('ol_rt='))!
      .split(';')[0]!;
    expect((await t.http.post('/v1/auth/refresh').set('Cookie', cookie).send({})).status).toBe(401);
    expect(
      (
        await t.http
          .post('/v1/auth/refresh')
          .set('x-client', 'web')
          .set('Cookie', cookie)
          .set('Origin', 'https://evil.example')
          .send({})
      ).status,
    ).toBe(403);
  });
});

describe('switch tenant', () => {
  it('re-scopes the session to another tenant the user belongs to and invalidates the old access token', async () => {
    const a = await registerTenant(t, { tenantName: 'Shop A' });
    const b = await registerTenant(t, { tenantName: 'Shop B' });
    const joined = await addMember(t, b, 'STAFF', { email: a.email, password: PASSWORD });
    expect(joined.memberships).toHaveLength(2);

    const switched = await t.http
      .post('/v1/auth/switch-tenant')
      .set(bearer(a.accessToken))
      .send({ tenantId: b.tenant.id });
    expect(switched.status).toBe(200);
    expect(switched.body.tenant.id).toBe(b.tenant.id);
    expect(switched.body.role).toBe('STAFF');

    const me = await t.http.get('/v1/me').set(bearer(switched.body.accessToken));
    expect(me.body.tenant.id).toBe(b.tenant.id);
    // The pre-switch token named tenant A, but the session now points at B.
    expect((await t.http.get('/v1/me').set(bearer(a.accessToken))).status).toBe(401);
  });

  it('refuses a tenant the user does not belong to, and does not reveal whether it exists', async () => {
    const a = await registerTenant(t);
    const stranger = await registerTenant(t);
    const real = await t.http
      .post('/v1/auth/switch-tenant')
      .set(bearer(a.accessToken))
      .send({ tenantId: stranger.tenant.id });
    const fake = await t.http
      .post('/v1/auth/switch-tenant')
      .set(bearer(a.accessToken))
      .send({ tenantId: '0197b0a0-0000-7000-8000-00000000dead' });
    expect(real.status).toBe(403);
    expect(fake.status).toBe(403);
    expect(real.body).toEqual(fake.body);
    expect((await t.http.get('/v1/me').set(bearer(a.accessToken))).status).toBe(200);
  });

  it('login can choose which tenant to enter', async () => {
    const a = await registerTenant(t, { tenantName: 'Alpha' });
    const b = await registerTenant(t, { tenantName: 'Beta' });
    await addMember(t, b, 'MANAGER', { email: a.email });
    const login = await t.http
      .post('/v1/auth/login')
      .send({ email: a.email, password: PASSWORD, tenantId: b.tenant.id });
    expect(login.body.tenant.id).toBe(b.tenant.id);
    expect(login.body.role).toBe('MANAGER');
    const notMine = await t.http.post('/v1/auth/login').send({
      email: a.email,
      password: PASSWORD,
      tenantId: '0197b0a0-0000-7000-8000-00000000dead',
    });
    expect(notMine.status).toBe(403);
  });
});
