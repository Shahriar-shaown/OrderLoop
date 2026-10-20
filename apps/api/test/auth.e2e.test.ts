import type { AuthResult } from '@orderloop/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/auth.service.js';
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
    const res = await t.http.post('/v1/auth/register').send({
      email: owner.email.toUpperCase(),
      password: PASSWORD,
      name: 'Xavier',
      tenantName: 'Yellow Shop',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conflict');
  });

  it('tells the owner of an address that someone tried to register it again, at most three times an hour', async () => {
    const owner = await registerTenant(t);
    const again = () =>
      t.http.post('/v1/auth/register').send({
        email: owner.email,
        password: PASSWORD,
        name: 'Xavier',
        tenantName: 'Yellow Shop',
      });
    expect((await again()).status).toBe(409);
    await t.app.get(AuthService).idle();
    const notices = () => t.mail.to(owner.email, 'account_exists');
    expect(notices()).toHaveLength(1);
    // Nothing a stranger chose is in the email, and it points at sign-in, not at a link that creates anything.
    expect(notices()[0]!.text).not.toMatch(/Xavier|Yellow Shop/);
    for (let i = 0; i < 4; i++) await again();
    await t.app.get(AuthService).idle();
    expect(notices()).toHaveLength(3);
    // The existing account is untouched: one tenant, signing in works.
    expect(
      (await t.http.post('/v1/auth/login').send({ email: owner.email, password: PASSWORD })).body
        .memberships,
    ).toHaveLength(1);
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

describe('refresh token grace window', () => {
  let graceApp: TestApp;
  beforeAll(async () => {
    graceApp = await createTestApp({ REFRESH_REUSE_GRACE_SECONDS: '10' });
  });
  afterAll(() => graceApp.close());
  const refresh = (token: string) =>
    graceApp.http.post('/v1/auth/refresh').send({ refreshToken: token });

  it('a retry with the token whose response was lost gets a working session instead of ending it', async () => {
    const owner = await registerTenant(graceApp);
    const first = await refresh(owner.refreshToken); // the response to this one never reached the client
    expect(first.status).toBe(200);
    const retry = await refresh(owner.refreshToken);
    expect(retry.status).toBe(200);
    expect(retry.body.refreshToken).not.toBe(first.body.refreshToken);
    expect((await graceApp.http.get('/v1/me').set(bearer(retry.body.accessToken))).status).toBe(
      200,
    );
    // The session carries on from the retry's token.
    expect((await refresh(retry.body.refreshToken)).status).toBe(200);
  });

  it('once the newer token has been used, the older one is theft again, even inside the window', async () => {
    const owner = await registerTenant(graceApp);
    const first = await refresh(owner.refreshToken);
    expect((await refresh(first.body.refreshToken)).status).toBe(200); // the client moved on
    const replay = await refresh(owner.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('token_reuse_detected');
    const session = await graceApp.db.global.session.findFirstOrThrow({
      where: { user: { email: owner.email } },
    });
    expect(session.revokedReason).toBe('refresh_token_reuse');
  });

  it('after the window a replay still ends the whole session', async () => {
    const owner = await registerTenant(graceApp);
    const first = await refresh(owner.refreshToken);
    const user = await graceApp.db.global.user.findUniqueOrThrow({ where: { email: owner.email } });
    // Age the exchange past the window.
    await graceApp.db.global.refreshToken.updateMany({
      where: { session: { userId: user.id }, usedAt: { not: null } },
      data: { usedAt: new Date(Date.now() - 11_000) },
    });
    const replay = await refresh(owner.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('token_reuse_detected');
    expect((await refresh(first.body.refreshToken)).status).toBe(401);
  });

  it('does not extend the window to a session that has been signed out', async () => {
    const owner = await registerTenant(graceApp);
    const first = await refresh(owner.refreshToken);
    await graceApp.http.post('/v1/auth/logout').set(bearer(first.body.accessToken)).expect(200);
    expect((await refresh(owner.refreshToken)).status).toBe(401);
  });
});

describe('switch tenant', () => {
  it('starts a session in the other tenant and leaves the one it came from on its own tenant', async () => {
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
    expect(switched.body.refreshToken).toBeTruthy();

    const me = await t.http.get('/v1/me').set(bearer(switched.body.accessToken));
    expect(me.body.tenant.id).toBe(b.tenant.id);
    // Another tab holding the pre-switch token and refresh token is not moved: it still works, in tenant A.
    const stay = await t.http.get('/v1/me').set(bearer(a.accessToken));
    expect(stay.status).toBe(200);
    expect(stay.body.tenant.id).toBe(a.tenant.id);
    const refreshed = await t.http.post('/v1/auth/refresh').send({ refreshToken: a.refreshToken });
    expect(refreshed.body.tenant.id).toBe(a.tenant.id);
    // The new session refreshes in tenant B, and signing out of one does not end the other.
    const other = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: switched.body.refreshToken });
    expect(other.body.tenant.id).toBe(b.tenant.id);
    await t.http.post('/v1/auth/logout').set(bearer(other.body.accessToken)).expect(200);
    expect((await t.http.get('/v1/me').set(bearer(refreshed.body.accessToken))).status).toBe(200);
  });

  it('a switched session cannot outlive the session it came from', async () => {
    const a = await registerTenant(t, { tenantName: 'Shop A' });
    const b = await registerTenant(t, { tenantName: 'Shop B' });
    await addMember(t, b, 'STAFF', { email: a.email, password: PASSWORD });
    const soon = new Date(Date.now() + 3_600_000);
    await t.db.global.session.updateMany({
      where: { user: { email: a.email } },
      data: { expiresAt: soon },
    });
    await t.http
      .post('/v1/auth/switch-tenant')
      .set(bearer(a.accessToken))
      .send({ tenantId: b.tenant.id })
      .expect(200);
    const sessions = await t.db.global.session.findMany({ where: { user: { email: a.email } } });
    expect(sessions).toHaveLength(3); // sign-up, accepting the invitation, and the switch
    expect(sessions.every((x) => x.expiresAt.getTime() === soon.getTime())).toBe(true);
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
