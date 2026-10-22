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
import { withAdmin } from './deletion-helpers.js';

/**
 * A person deletes their own account (docs/privacy-and-deletion.md): password asked again, refused while they alone own a
 * business with other members, everything personal removed, the row kept but anonymised, the email free to register again.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

type Reg = Awaited<ReturnType<typeof registerTenant>>;
const del = (who: { accessToken: string }, body: object) =>
  t.http.post('/v1/me/delete').set(bearer(who.accessToken)).send(body);
const ok = { password: PASSWORD, confirm: 'DELETE' };

const userRow = (id: string) =>
  withAdmin(async (c) => (await c.query('SELECT * FROM users WHERE id = $1', [id])).rows[0]);

describe('re-authentication and confirmation', () => {
  it('a wrong password is 401 invalid_credentials, like signing in, and changes nothing', async () => {
    const a = await registerTenant(t);
    const r = await del(a, { password: 'Not-the-password-1!', confirm: 'DELETE' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('invalid_credentials');
    // still signed in, account intact
    await t.http.get('/v1/me').set(bearer(a.accessToken)).expect(200);
    expect((await userRow(a.user.id)).deleted_at).toBeNull();
  });

  it('needs the word DELETE and a password in the body', async () => {
    const a = await registerTenant(t);
    expect((await del(a, { password: PASSWORD })).status).toBe(400);
    expect((await del(a, { password: PASSWORD, confirm: 'delete' })).status).toBe(400);
    expect((await del(a, { confirm: 'DELETE' })).status).toBe(400);
    expect((await t.http.post('/v1/me/delete').send(ok)).status).toBe(401);
    expect((await userRow(a.user.id)).deleted_at).toBeNull();
  });

  it('counts wrong passwords toward the same lockout as signing in', async () => {
    const a = await registerTenant(t);
    for (let i = 0; i < 5; i++)
      expect((await del(a, { password: 'Wrong-password-9!', confirm: 'DELETE' })).status).toBe(401);
    // locked now: even the right password is refused until the window passes
    const locked = await del(a, ok);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('rate_limited');
    expect((await userRow(a.user.id)).deleted_at).toBeNull();
  });
});

describe('the only owner of a business that has other members', () => {
  it('is refused with 409 account_delete_blocked until ownership is handed over, then it works', async () => {
    const owner = await registerTenant(t, { tenantName: 'Blocked Shop' });
    const staff = await addMember(t, owner, 'STAFF');
    const admin = await addMember(t, owner, 'ADMIN');

    const blocked = await del(owner, ok);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('account_delete_blocked');
    expect(blocked.body.errors).toEqual([{ path: 'businesses', message: 'Blocked Shop' }]);
    // nothing happened: still a member, still signed in, nothing scheduled
    await t.http.get('/v1/members').set(bearer(owner.accessToken)).expect(200);
    expect((await userRow(owner.user.id)).deleted_at).toBeNull();
    const status = await t.http.get('/v1/tenant/deletion-status').set(bearer(owner.accessToken));
    expect(status.body.scheduled).toBe(false);

    // another owner: the block lifts
    const members = (await t.http.get('/v1/members').set(bearer(owner.accessToken))).body as {
      id: string;
      userId: string;
    }[];
    await t.http
      .patch(`/v1/members/${members.find((m) => m.userId === admin.user.id)!.id}`)
      .set(bearer(owner.accessToken))
      .send({ role: 'OWNER' })
      .expect(200);
    const done = await del(owner, ok).expect(200);
    expect(done.body).toEqual({ deleted: true, businessesScheduled: [] });
    // the business lives on for the others
    await t.http.get('/v1/members').set(bearer(admin.accessToken)).expect(200);
    const left = (await t.http.get('/v1/members').set(bearer(admin.accessToken))).body as {
      userId: string;
    }[];
    expect(left.map((m) => m.userId).sort()).toEqual([admin.user.id, staff.user.id].sort());
  });

  it('a non-owner member, or one of two owners, is not blocked', async () => {
    const owner = await registerTenant(t);
    const staff = await addMember(t, owner, 'STAFF');
    await del(staff, { password: PASSWORD, confirm: 'DELETE' }).expect(200);
    const second = await addMember(t, owner, 'OWNER');
    await del(second, ok).expect(200);
    // the owner is still the owner, with their business
    expect((await t.http.get('/v1/tenant').set(bearer(owner.accessToken))).status).toBe(200);
  });
});

describe('what deleting an account does', () => {
  it('ends every session, removes the personal data, keeps the row anonymised and frees the email', async () => {
    const owner = await registerTenant(t, { tenantName: 'Solo Shop' });
    // a second device: a second session, a push token, an invitation sent, a notification setting
    const second = await t.http
      .post('/v1/auth/login')
      .send({ email: owner.email, password: PASSWORD })
      .expect(200);
    await t.http
      .post('/v1/push-devices')
      .set(bearer(owner.accessToken))
      .send({ token: `ExponentPushToken[${owner.user.id.slice(0, 18)}]`, platform: 'android' })
      .expect(200);
    const invited = uniqueEmail('invitee');
    await t.http
      .post('/v1/members/invitations')
      .set(bearer(owner.accessToken))
      .send({ email: invited, role: 'STAFF' })
      .expect(201);
    // a business of which they are a plain member (not the sole owner), so it survives
    const other = await registerTenant(t, { tenantName: 'Someone Elses' });
    const joined = await addMember(t, other, 'STAFF', { email: owner.email });
    expect(joined.user.id).toBe(owner.user.id);

    const res = await del(owner, ok).expect(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.businessesScheduled).toHaveLength(1);
    expect(res.body.businessesScheduled[0]).toMatchObject({
      id: owner.tenant.id,
      name: 'Solo Shop',
    });
    expect(new Date(res.body.businessesScheduled[0].purgeAfter).getTime()).toBeGreaterThan(
      Date.now() + 13 * 86_400_000,
    );

    // every token is dead
    for (const token of [owner.accessToken, second.body.accessToken, joined.accessToken])
      expect((await t.http.get('/v1/me').set(bearer(token))).status).toBe(401);
    const refresh = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: owner.refreshToken });
    expect([401]).toContain(refresh.status);
    expect(
      (await t.http.post('/v1/auth/login').send({ email: owner.email, password: PASSWORD })).status,
    ).toBe(401);

    // the row is kept but holds nothing personal
    const row = await userRow(owner.user.id);
    expect(row.email).toBe(`deleted-${owner.user.id}@deleted.invalid`);
    expect(row).toMatchObject({ name: 'Deleted user', password_hash: '' });
    expect(row.disabled_at).not.toBeNull();
    expect(row.deleted_at).not.toBeNull();
    const rest = await withAdmin(async (c) => ({
      sessions: (
        await c.query('SELECT count(*)::int n FROM sessions WHERE user_id = $1', [owner.user.id])
      ).rows[0].n,
      tokens: (
        await c.query('SELECT count(*)::int n FROM user_tokens WHERE user_id = $1', [owner.user.id])
      ).rows[0].n,
      devices: (
        await c.query('SELECT count(*)::int n FROM push_devices WHERE user_id = $1', [
          owner.user.id,
        ])
      ).rows[0].n,
      memberships: (
        await c.query('SELECT count(*)::int n FROM memberships WHERE user_id = $1', [owner.user.id])
      ).rows[0].n,
      ips: (
        await c.query(
          'SELECT count(*)::int n FROM audit_logs WHERE actor_user_id = $1 AND ip IS NOT NULL',
          [owner.user.id],
        )
      ).rows[0].n,
      invitationLive: (
        await c.query(
          'SELECT count(*)::int n FROM invitations WHERE tenant_id = $1 AND email = $2 AND revoked_at IS NULL',
          [owner.tenant.id, invited],
        )
      ).rows[0].n,
      scheduled: (
        await c.query(
          'SELECT purge_after IS NOT NULL AS s, deletion_requested_by_id FROM tenants WHERE id = $1',
          [owner.tenant.id],
        )
      ).rows[0],
    }));
    expect(rest).toMatchObject({
      sessions: 0,
      tokens: 0,
      devices: 0,
      memberships: 0,
      ips: 0,
      invitationLive: 0,
      scheduled: { s: true, deletion_requested_by_id: owner.user.id },
    });

    // the other business is told, in its audit trail, with an id and no personal data
    const audit = (await t.http.get('/v1/audit-logs?limit=100').set(bearer(other.accessToken))).body
      .items as { action: string; actorUserId: string; targetId: string }[];
    const entry = audit.find((e) => e.action === 'account.deleted');
    expect(entry).toMatchObject({ actorUserId: owner.user.id, targetId: owner.user.id });
    // and it no longer lists the person
    const members = (await t.http.get('/v1/members').set(bearer(other.accessToken))).body as {
      userId: string;
    }[];
    expect(members.map((m) => m.userId)).not.toContain(owner.user.id);

    // an email to the OLD address, without a link or token
    const mails = t.mail.sent.filter((m) => m.kind === 'account_deleted');
    const mine = mails.find((m) => m.to === owner.email);
    expect(mine).toBeTruthy();
    expect(mine!.text).not.toMatch(/token=|https?:\/\//);

    // the same address can register again, as a different person with a fresh business
    const again = await t.http
      .post('/v1/auth/register')
      .send({
        email: owner.email,
        password: PASSWORD,
        name: 'Brand New',
        tenantName: 'Fresh Start',
      })
      .expect(201);
    expect(again.body.user.id).not.toBe(owner.user.id);
    expect(again.body.tenant.name).toBe('Fresh Start');
  });

  it('clears the browser refresh cookie', async () => {
    const owner = await registerTenant(t);
    const r = await t.http
      .post('/v1/me/delete')
      .set(bearer(owner.accessToken))
      .set('x-client', 'web')
      .send(ok)
      .expect(200);
    expect(String(r.headers['set-cookie'])).toMatch(/ol_rt=;/);
  });

  it('works from a business that is already scheduled for deletion', async () => {
    const owner = await registerTenant(t);
    await t.http
      .post('/v1/tenant/delete-request')
      .set(bearer(owner.accessToken))
      .send({ confirmName: 'Test Shop', password: PASSWORD })
      .expect(200);
    const res = await del(owner, ok).expect(200);
    // already scheduled: not scheduled a second time
    expect(res.body.businessesScheduled).toEqual([]);
  });

  it('only the person themselves can reach it: the database refuses another user id', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    await expect(
      t.db.withContext(
        { userId: a.user.id },
        (tx) => tx.$executeRaw`SELECT delete_own_account(${b.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/not scoped to this user/);
    // and the helper behind it is not callable at all
    await expect(
      t.db.withContext(
        { userId: a.user.id },
        (tx) => tx.$executeRaw`SELECT _anonymise_user(${a.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/permission denied/);
    expect((await userRow(b.user.id)).deleted_at).toBeNull();
  });
});
