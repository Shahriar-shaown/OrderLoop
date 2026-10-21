import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeSessions } from '../src/auth/revoke-sessions.js';
import { addMember, bearer, createTestApp, registerTenant, type TestApp } from './app.js';

let t: TestApp;
let admin: pg.Client;
beforeAll(async () => {
  t = await createTestApp();
  // The admin URL names the development database; point it at the isolated test database the API under test uses.
  const url = new URL(process.env['DATABASE_ADMIN_URL']!);
  url.pathname = new URL(process.env['DATABASE_URL']!).pathname;
  if (!url.pathname.endsWith('_test'))
    throw new Error('refusing to revoke sessions outside the test database');
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
  await t.close();
});

const me = (token: string) => t.http.get('/v1/me').set(bearer(token));

describe('sessions:revoke', () => {
  it('a dry run counts and changes nothing; --yes revokes one user only', async () => {
    const [a, b] = [await registerTenant(t), await registerTenant(t)];
    const dry = await revokeSessions(admin, { kind: 'user', email: a.email }, false);
    expect(dry).toMatchObject({ dryRun: true, matched: 1, revoked: 0 });
    expect((await me(a.accessToken)).status).toBe(200);

    const done = await revokeSessions(admin, { kind: 'user', email: a.email.toUpperCase() }, true);
    expect(done).toMatchObject({ dryRun: false, revoked: 1 });
    expect((await me(a.accessToken)).status).toBe(401);
    expect(
      (await t.http.post('/v1/auth/refresh').send({ refreshToken: a.refreshToken })).status,
    ).toBe(401);
    expect((await me(b.accessToken)).status).toBe(200);
    // already revoked sessions are not counted again
    expect((await revokeSessions(admin, { kind: 'user', email: a.email }, false)).matched).toBe(0);
    const row = await admin.query(
      `SELECT revoked_reason FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [a.email],
    );
    expect(row.rows[0].revoked_reason).toBe('incident');
  });

  it('--tenant revokes every member of that business and nobody else', async () => {
    const owner = await registerTenant(t);
    const member = await addMember(t, owner, 'STAFF');
    const other = await registerTenant(t);
    const r = await revokeSessions(admin, { kind: 'tenant', tenantId: owner.tenant.id }, true);
    expect(r.revoked).toBeGreaterThanOrEqual(2);
    expect((await me(owner.accessToken)).status).toBe(401);
    expect((await me(member.accessToken)).status).toBe(401);
    expect((await me(other.accessToken)).status).toBe(200);
  });

  it('--all revokes everything live', async () => {
    const x = await registerTenant(t);
    expect((await me(x.accessToken)).status).toBe(200);
    const r = await revokeSessions(admin, { kind: 'all' }, true);
    expect(r.revoked).toBeGreaterThanOrEqual(1);
    expect((await me(x.accessToken)).status).toBe(401);
    expect((await revokeSessions(admin, { kind: 'all' }, false)).matched).toBe(0);
  });

  it('refuses a malformed tenant id', async () => {
    await expect(
      revokeSessions(admin, { kind: 'tenant', tenantId: "x'; --" }, true),
    ).rejects.toThrow(/UUID/);
  });
});
