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

const backdate = (
  email: string,
  purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
  field: 'createdAt' | 'expiresAt',
  ms: number,
) =>
  t.db.global.userToken.updateMany({
    where: { user: { email }, purpose },
    data: { [field]: new Date(Date.now() + ms) },
  });

describe('email verification', () => {
  it('sends one email on registration, never returns the token, and stores only its hash', async () => {
    const email = uniqueEmail('verify');
    const res = await t.http
      .post('/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'V', tenantName: 'V Shop' });
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(false);
    expect(t.mail.to(email, 'verify_email')).toHaveLength(1);
    const token = t.mail.tokenFor(email, 'verify_email');
    expect(JSON.stringify(res.body)).not.toContain(token);
    const rows = await t.db.global.userToken.findMany({ where: { user: { email } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toHaveLength(64);
    expect(rows[0]!.tokenHash).not.toBe(token);
  });

  it('verifies the address, exactly once', async () => {
    const owner = await registerTenant(t, { verify: false });
    expect(
      (await t.http.get('/v1/me').set(bearer(owner.accessToken))).body.user.emailVerified,
    ).toBe(false);
    const token = t.mail.tokenFor(owner.email, 'verify_email');

    expect((await t.http.post('/v1/auth/verify-email').send({ token })).status).toBe(200);
    expect(
      (await t.http.get('/v1/me').set(bearer(owner.accessToken))).body.user.emailVerified,
    ).toBe(true);

    const again = await t.http.post('/v1/auth/verify-email').send({ token });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('token_invalid');
  });

  it('rejects unknown, expired and wrong-purpose tokens with the same answer', async () => {
    const owner = await registerTenant(t, { verify: false });
    const real = t.mail.tokenFor(owner.email, 'verify_email');
    const unknown = await t.http.post('/v1/auth/verify-email').send({ token: 'x'.repeat(43) });
    await backdate(owner.email, 'EMAIL_VERIFICATION', 'expiresAt', -1000);
    const expired = await t.http.post('/v1/auth/verify-email').send({ token: real });
    expect([unknown.status, expired.status]).toEqual([400, 400]);
    expect(unknown.body).toEqual(expired.body);

    // A password-reset token must not verify an email address (purpose confusion).
    await t.http.post('/v1/auth/forgot-password').send({ email: owner.email });
    await settle();
    const resetToken = t.mail.tokenFor(owner.email, 'password_reset');
    expect((await t.http.post('/v1/auth/verify-email').send({ token: resetToken })).status).toBe(
      400,
    );
  });

  it('two simultaneous redemptions of one link: exactly one succeeds', async () => {
    const owner = await registerTenant(t, { verify: false });
    const token = t.mail.tokenFor(owner.email, 'verify_email');
    const results = await Promise.all(
      [1, 2, 3].map(() => t.http.post('/v1/auth/verify-email').send({ token })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
  });

  it('an unverified owner cannot invite people; verifying unlocks it', async () => {
    const owner = await registerTenant(t, { verify: false });
    const blocked = await t.http
      .post('/v1/members/invitations')
      .set(bearer(owner.accessToken))
      .send({ email: uniqueEmail(), role: 'STAFF' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('email_not_verified');

    await t.http
      .post('/v1/auth/verify-email')
      .send({ token: t.mail.tokenFor(owner.email, 'verify_email') })
      .expect(200);
    await t.http
      .post('/v1/members/invitations')
      .set(bearer(owner.accessToken))
      .send({ email: uniqueEmail(), role: 'STAFF' })
      .expect(201);
  });

  it('resend: needs a session, sends a fresh link that replaces the old one, and respects a cooldown', async () => {
    expect((await t.http.post('/v1/auth/resend-verification')).status).toBe(401);
    const owner = await registerTenant(t, { verify: false });
    const first = t.mail.tokenFor(owner.email, 'verify_email');

    // Immediately after registering, the cooldown suppresses another email.
    await t.http.post('/v1/auth/resend-verification').set(bearer(owner.accessToken)).expect(200);
    expect(t.mail.to(owner.email, 'verify_email')).toHaveLength(1);

    await backdate(owner.email, 'EMAIL_VERIFICATION', 'createdAt', -120_000);
    await t.http.post('/v1/auth/resend-verification').set(bearer(owner.accessToken)).expect(200);
    expect(t.mail.to(owner.email, 'verify_email')).toHaveLength(2);
    const second = t.mail.tokenFor(owner.email, 'verify_email');
    expect(second).not.toBe(first);

    expect((await t.http.post('/v1/auth/verify-email').send({ token: first })).status).toBe(400); // superseded
    expect((await t.http.post('/v1/auth/verify-email').send({ token: second })).status).toBe(200);

    // Already verified: nothing is sent.
    await t.http.post('/v1/auth/resend-verification').set(bearer(owner.accessToken)).expect(200);
    expect(t.mail.to(owner.email, 'verify_email')).toHaveLength(2);
  });

  it('emails carry no text a stranger chose: a hostile name never reaches the victim', async () => {
    const victim = uniqueEmail('victim');
    const res = await t.http.post('/v1/auth/register').send({
      email: victim,
      password: PASSWORD,
      name: 'Click https://evil.example/pay now',
      tenantName: 'Shop',
    });
    expect(res.status).toBe(201);
    const mail = t.mail.to(victim, 'verify_email')[0]!;
    for (const body of [mail.text, mail.html, mail.subject]) {
      expect(body).not.toContain('evil.example');
      expect(body).not.toContain('Click');
    }
  });

  it('names with line breaks or invisible characters are rejected at registration', async () => {
    for (const name of ['Ann\nBob', 'Ann\u200bLee', 'Ann\u202eLee']) {
      const res = await t.http
        .post('/v1/auth/register')
        .send({ email: uniqueEmail('nm'), password: PASSWORD, name, tenantName: 'Shop' });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(res.body.errors[0].path).toBe('body.name');
    }
  });

  it('accepting an invitation proves control of the invited address', async () => {
    const owner = await registerTenant(t);
    const member = await addMember(t, owner, 'STAFF');
    expect(member.user.emailVerified).toBe(true);
    expect(
      (await t.http.get('/v1/me').set(bearer(member.accessToken))).body.user.emailVerified,
    ).toBe(true);
  });
});

/** forgot-password does its work after responding (so timing cannot reveal whether an account exists); wait for it. */
const settle = () => t.app.get(AuthService).idle();

describe('password reset', () => {
  it('answers identically for known and unknown addresses, and only emails the known one', async () => {
    const owner = await registerTenant(t);
    const ghost = uniqueEmail('ghost');
    const known = await t.http.post('/v1/auth/forgot-password').send({ email: owner.email });
    const unknown = await t.http.post('/v1/auth/forgot-password').send({ email: ghost });
    await settle();
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(t.mail.to(owner.email, 'password_reset')).toHaveLength(1);
    expect(t.mail.to(ghost)).toHaveLength(0);
  });

  it('never returns the token and stores only its hash', async () => {
    const owner = await registerTenant(t);
    const res = await t.http.post('/v1/auth/forgot-password').send({ email: owner.email });
    await settle();
    const token = t.mail.tokenFor(owner.email, 'password_reset');
    expect(JSON.stringify(res.body)).not.toContain(token);
    const rows = await t.db.global.userToken.findMany({
      where: { user: { email: owner.email }, purpose: 'PASSWORD_RESET' },
    });
    expect(rows.every((r) => r.tokenHash !== token && r.tokenHash.length === 64)).toBe(true);
  });

  it('sets the new password, ends every session, and tells the user', async () => {
    const owner = await registerTenant(t);
    const second = await t.http
      .post('/v1/auth/login')
      .send({ email: owner.email, password: PASSWORD }); // a second device
    await t.http.post('/v1/auth/forgot-password').send({ email: owner.email });
    await settle();
    const token = t.mail.tokenFor(owner.email, 'password_reset');

    const newPassword = 'a brand new long passphrase';
    expect(
      (await t.http.post('/v1/auth/reset-password').send({ token, password: newPassword })).status,
    ).toBe(200);

    // Old password is dead, new one works.
    expect(
      (await t.http.post('/v1/auth/login').send({ email: owner.email, password: PASSWORD })).status,
    ).toBe(401);
    expect(
      (await t.http.post('/v1/auth/login').send({ email: owner.email, password: newPassword }))
        .status,
    ).toBe(200);

    // Every pre-reset session is revoked: access tokens and refresh tokens, on both devices.
    for (const session of [owner, second.body as typeof owner]) {
      expect((await t.http.get('/v1/me').set(bearer(session.accessToken))).status).toBe(401);
      expect(
        (await t.http.post('/v1/auth/refresh').send({ refreshToken: session.refreshToken })).status,
      ).toBe(401);
    }
    expect(t.mail.to(owner.email, 'password_changed')).toHaveLength(1);
    expect(t.mail.to(owner.email, 'password_changed')[0]!.text).not.toMatch(/token=/);
  });

  it('the link works once, and spending any link expires the others', async () => {
    const owner = await registerTenant(t);
    await t.http.post('/v1/auth/forgot-password').send({ email: owner.email });
    await settle();
    const first = t.mail.tokenFor(owner.email, 'password_reset');
    await t.http.post('/v1/auth/forgot-password').send({ email: owner.email });
    await settle();
    const second = t.mail.tokenFor(owner.email, 'password_reset');
    expect(second).not.toBe(first);

    expect(
      (
        await t.http
          .post('/v1/auth/reset-password')
          .send({ token: first, password: 'whatever long enough 1' })
      ).status,
    ).toBe(200);
    const replay = await t.http
      .post('/v1/auth/reset-password')
      .send({ token: first, password: 'attacker chosen password' });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('token_invalid');
    expect(
      (
        await t.http
          .post('/v1/auth/reset-password')
          .send({ token: second, password: 'attacker chosen password' })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.http
          .post('/v1/auth/login')
          .send({ email: owner.email, password: 'attacker chosen password' })
      ).status,
    ).toBe(401);
  });

  it('someone else requesting resets for your address cannot kill the link you already have', async () => {
    const victim = await registerTenant(t);
    await t.http.post('/v1/auth/forgot-password').send({ email: victim.email });
    await settle();
    const yours = t.mail.tokenFor(victim.email, 'password_reset');
    // An attacker hammers the endpoint for the victim's address.
    for (let i = 0; i < 2; i++)
      await t.http.post('/v1/auth/forgot-password').send({ email: victim.email });
    await settle();
    expect(
      (
        await t.http
          .post('/v1/auth/reset-password')
          .send({ token: yours, password: 'the real owner picks this' })
      ).status,
    ).toBe(200);
  });

  it('does all of its work after responding, so a known and an unknown address are handled identically before the answer', async () => {
    const owner = await registerTenant(t);
    const service = t.app.get(AuthService);
    // Before awaiting the deferred work, nothing has been issued or sent yet for a known address...
    const res = await t.http.post('/v1/auth/forgot-password').send({ email: owner.email });
    expect(res.status).toBe(200);
    await service.idle();
    // ...and afterwards exactly one email exists. (The response itself never depended on that work.)
    expect(t.mail.to(owner.email, 'password_reset')).toHaveLength(1);
  });

  it('a weak new password is rejected without spending the token', async () => {
    const owner = await registerTenant(t);
    await t.http.post('/v1/auth/forgot-password').send({ email: owner.email });
    await settle();
    const token = t.mail.tokenFor(owner.email, 'password_reset');
    const weak = await t.http.post('/v1/auth/reset-password').send({ token, password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('validation_failed');
    expect(
      (
        await t.http
          .post('/v1/auth/reset-password')
          .send({ token, password: 'now a long enough one' })
      ).status,
    ).toBe(200);
  });

  it('rejects expired, unknown and wrong-purpose tokens identically', async () => {
    const owner = await registerTenant(t);
    await t.http.post('/v1/auth/forgot-password').send({ email: owner.email });
    await settle();
    const token = t.mail.tokenFor(owner.email, 'password_reset');
    await backdate(owner.email, 'PASSWORD_RESET', 'expiresAt', -1000);
    const expired = await t.http
      .post('/v1/auth/reset-password')
      .send({ token, password: 'long enough password' });
    const unknown = await t.http
      .post('/v1/auth/reset-password')
      .send({ token: 'y'.repeat(43), password: 'long enough password' });
    // A verification token is not a reset token.
    const fresh = await registerTenant(t, { verify: false });
    const wrongPurpose = await t.http.post('/v1/auth/reset-password').send({
      token: t.mail.tokenFor(fresh.email, 'verify_email'),
      password: 'long enough password',
    });
    for (const res of [expired, unknown, wrongPurpose]) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('token_invalid');
    }
  });

  it('two simultaneous resets with one link: exactly one wins', async () => {
    const owner = await registerTenant(t);
    await t.http.post('/v1/auth/forgot-password').send({ email: owner.email });
    await settle();
    const token = t.mail.tokenFor(owner.email, 'password_reset');
    const results = await Promise.all(
      ['one long passphrase', 'two long passphrase', 'three long passphrase'].map((password) =>
        t.http.post('/v1/auth/reset-password').send({ token, password }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
  });

  it('a disabled account gets no reset email', async () => {
    const owner = await registerTenant(t);
    await t.db.global.user.update({
      where: { email: owner.email },
      data: { disabledAt: new Date() },
    });
    expect(
      (await t.http.post('/v1/auth/forgot-password').send({ email: owner.email })).status,
    ).toBe(200);
    await settle();
    expect(t.mail.to(owner.email, 'password_reset')).toHaveLength(0);
  });

  it('limits reset emails per address to three an hour while still answering 200', async () => {
    const owner = await registerTenant(t);
    for (let i = 0; i < 5; i++)
      expect(
        (await t.http.post('/v1/auth/forgot-password').send({ email: owner.email })).status,
      ).toBe(200);
    await settle();
    expect(t.mail.to(owner.email, 'password_reset')).toHaveLength(3);
  });

  it('records the completed reset, but not unauthenticated requests, in the tenant audit log', async () => {
    const owner = await registerTenant(t);
    await t.http.post('/v1/auth/forgot-password').send({ email: owner.email });
    await settle();
    const token = t.mail.tokenFor(owner.email, 'password_reset');
    await t.http
      .post('/v1/auth/reset-password')
      .send({ token, password: 'audit trail passphrase' });
    const login = await t.http
      .post('/v1/auth/login')
      .send({ email: owner.email, password: 'audit trail passphrase' });
    const actions = (
      await t.http.get('/v1/audit-logs?limit=100').set(bearer(login.body.accessToken))
    ).body.items.map((i: { action: string }) => i.action);
    expect(actions).toContain('auth.password_reset');
    // The unauthenticated request endpoint writes nothing into tenants' audit logs: anyone who knows an email
    // address could otherwise fill that tenant's audit trail with entries carrying their own IP.
    expect(actions).not.toContain('auth.password_reset_requested');
  });
});
