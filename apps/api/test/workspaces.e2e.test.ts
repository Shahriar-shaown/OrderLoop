import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  createTestApp,
  registerTenant,
  uniqueEmail,
  type TestApp,
} from './app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const audit = async (token: string) =>
  (await t.http.get('/v1/audit-logs').set(bearer(token)).expect(200)).body.items as {
    action: string;
    targetId: string | null;
  }[];

describe('business profile', () => {
  it('starts with BDT, Asia/Dhaka and English', async () => {
    const a = await registerTenant(t);
    expect(a.tenant).toMatchObject({
      currency: 'BDT',
      timezone: 'Asia/Dhaka',
      defaultLanguage: 'en',
    });
    const info = (await t.http.get('/v1/tenant').set(bearer(a.accessToken)).expect(200)).body;
    expect(info).toMatchObject({ country: 'BD', logoUrl: null, contactEmail: null });
  });

  it('lets an owner update profile fields and audits the change without values', async () => {
    const a = await registerTenant(t);
    const res = await t.http
      .patch('/v1/tenant')
      .set(bearer(a.accessToken))
      .send({
        name: 'Dhaka Threads',
        contactEmail: 'hello@dhaka.test',
        contactPhone: '+880 1712-345678',
        city: 'Dhaka',
        defaultLanguage: 'bn',
        logoUrl: 'https://cdn.example.test/logo.png',
      })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'Dhaka Threads', defaultLanguage: 'bn', city: 'Dhaka' });
    const entry = (await audit(a.accessToken)).find((e) => e.action === 'tenant.updated');
    expect(entry).toBeTruthy();
    const row = await t.db.withContext({ tenantId: a.tenant.id }, (tx) =>
      tx.auditLog.findFirst({ where: { action: 'tenant.updated' } }),
    );
    expect(JSON.stringify(row?.metadata)).not.toContain('hello@dhaka.test');
    expect((row?.metadata as { changed: string[] }).changed).toContain('contactEmail');
  });

  it('rejects invalid values with field errors', async () => {
    const a = await registerTenant(t);
    const patch = (body: object) =>
      t.http.patch('/v1/tenant').set(bearer(a.accessToken)).send(body);
    expect((await patch({ currency: 'XXX' })).status).toBe(400);
    expect((await patch({ timezone: 'Mars/Base' })).status).toBe(400);
    expect((await patch({ logoUrl: 'http://insecure.test/a.png' })).status).toBe(400);
    expect((await patch({ contactPhone: 'abc' })).status).toBe(400);
    expect((await patch({ name: 'ab' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
  });

  it('allows clearing optional fields with null', async () => {
    const a = await registerTenant(t);
    const p = (body: object) => t.http.patch('/v1/tenant').set(bearer(a.accessToken)).send(body);
    await p({ city: 'Dhaka' }).expect(200);
    expect((await p({ city: null }).expect(200)).body.city).toBeNull();
  });
});

describe('who may change settings', () => {
  it('owner and admin may; manager, staff and accountant may not', async () => {
    const owner = await registerTenant(t);
    const admin = await addMember(t, owner, 'ADMIN');
    const others = [
      await addMember(t, owner, 'MANAGER'),
      await addMember(t, owner, 'STAFF'),
      await addMember(t, owner, 'ACCOUNTANT'),
    ];
    for (const who of others) {
      const r = await t.http
        .patch('/v1/tenant')
        .set(bearer(who.accessToken))
        .send({ city: 'X-town' });
      expect(r.status).toBe(403);
    }
    await t.http
      .patch('/v1/tenant')
      .set(bearer(admin.accessToken))
      .send({ city: 'Sylhet' })
      .expect(200);
    await t.http
      .patch('/v1/tenant')
      .set(bearer(owner.accessToken))
      .send({ city: 'Dhaka' })
      .expect(200);
    // the refused attempts changed nothing
    const info = (await t.http.get('/v1/tenant').set(bearer(owner.accessToken))).body;
    expect(info.city).toBe('Dhaka');
  });

  it('applies a role change on the very next request', async () => {
    const owner = await registerTenant(t);
    const admin = await addMember(t, owner, 'ADMIN');
    const members = (await t.http.get('/v1/members').set(bearer(owner.accessToken))).body as {
      id: string;
      userId: string;
    }[];
    const adminRow = members.find((m) => m.userId === admin.user.id)!;
    await t.http
      .patch(`/v1/members/${adminRow.id}`)
      .set(bearer(owner.accessToken))
      .send({ role: 'STAFF' })
      .expect(200);
    // same token, now only STAFF
    await t.http.patch('/v1/tenant').set(bearer(admin.accessToken)).send({ city: 'Z' }).expect(403);
    await t.http.delete(`/v1/members/${adminRow.id}`).set(bearer(owner.accessToken)).expect(200);
    await t.http.get('/v1/tenant').set(bearer(admin.accessToken)).expect(401);
    const actions = (await audit(owner.accessToken)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['member.role_changed', 'member.removed']));
  });
});

describe('workspaces', () => {
  it('lists only the businesses the caller belongs to', async () => {
    const a = await registerTenant(t, { tenantName: 'Alpha Store' });
    const b = await registerTenant(t, { tenantName: 'Bravo Store' });
    const listA = (await t.http.get('/v1/workspaces').set(bearer(a.accessToken)).expect(200)).body;
    expect(listA).toHaveLength(1);
    expect(listA[0]).toMatchObject({ id: a.tenant.id, name: 'Alpha Store', role: 'OWNER' });
    expect(JSON.stringify(listA)).not.toContain(b.tenant.id);
  });

  it('creates a second business, owned by the caller, and switches into it', async () => {
    const a = await registerTenant(t, { tenantName: 'First Shop' });
    const created = (
      await t.http
        .post('/v1/workspaces')
        .set(bearer(a.accessToken))
        .send({ name: 'Second Shop', currency: 'USD', defaultLanguage: 'bn' })
        .expect(201)
    ).body;
    expect(created).toMatchObject({
      name: 'Second Shop',
      role: 'OWNER',
      currency: 'USD',
      timezone: 'Asia/Dhaka',
    });
    const list = (await t.http.get('/v1/workspaces').set(bearer(a.accessToken))).body as {
      id: string;
    }[];
    expect(list.map((w) => w.id)).toEqual(expect.arrayContaining([a.tenant.id, created.id]));

    const switched = (
      await t.http
        .post('/v1/auth/switch-tenant')
        .set(bearer(a.accessToken))
        .send({ tenantId: created.id })
        .expect(200)
    ).body;
    expect(switched.tenant.id).toBe(created.id);
    expect(switched.role).toBe('OWNER');
    // data of the first business is not visible from the second
    const members = (await t.http.get('/v1/members').set(bearer(switched.accessToken)).expect(200))
      .body;
    expect(members).toHaveLength(1);
    const actions = (await audit(switched.accessToken)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['tenant.created', 'auth.switch_tenant']));
  });

  it('caps how many businesses one person can own', async () => {
    const a = await registerTenant(t);
    for (let i = 0; i < 9; i++)
      await t.http
        .post('/v1/workspaces')
        .set(bearer(a.accessToken))
        .send({ name: `Shop ${i}x` })
        .expect(201);
    await t.http
      .post('/v1/workspaces')
      .set(bearer(a.accessToken))
      .send({ name: 'One too many' })
      .expect(409);
  });

  it('refuses to switch into someone else’s or a missing business, identically', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    const other = await t.http
      .post('/v1/auth/switch-tenant')
      .set(bearer(a.accessToken))
      .send({ tenantId: b.tenant.id });
    const missing = await t.http
      .post('/v1/auth/switch-tenant')
      .set(bearer(a.accessToken))
      .send({ tenantId: '0197b0a0-0000-7000-8000-00000000dead' });
    expect(other.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(other.body).toEqual(missing.body);
    // the session is still scoped to A
    const me = (await t.http.get('/v1/me').set(bearer(a.accessToken)).expect(200)).body;
    expect(me.tenant.id).toBe(a.tenant.id);
    // and B logged nothing about it
    expect((await audit(b.accessToken)).some((e) => e.action === 'auth.switch_tenant')).toBe(false);
  });

  it('does not trust a workspace id sent by the client', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    // ids in body, query or headers are ignored or rejected; the token's verified membership decides
    const patch = await t.http
      .patch('/v1/tenant')
      .set(bearer(a.accessToken))
      .set('x-tenant-id', b.tenant.id)
      .send({ id: b.tenant.id, name: 'Hijacked' });
    expect(patch.status).toBe(400);
    const patch2 = await t.http
      .patch(`/v1/tenant?tenantId=${b.tenant.id}`)
      .set(bearer(a.accessToken))
      .set('x-tenant-id', b.tenant.id)
      .send({ name: 'Hijacked Too' })
      .expect(200);
    expect(patch2.body.id).toBe(a.tenant.id);
    const bInfo = (await t.http.get('/v1/tenant').set(bearer(b.accessToken))).body;
    expect(bInfo.name).not.toMatch(/Hijacked/);
  });

  it('rejects a token for a business the user has since left', async () => {
    const owner = await registerTenant(t);
    const staff = await addMember(t, owner, 'STAFF');
    const rows = (await t.http.get('/v1/members').set(bearer(owner.accessToken))).body as {
      id: string;
      userId: string;
    }[];
    await t.http
      .delete(`/v1/members/${rows.find((m) => m.userId === staff.user.id)!.id}`)
      .set(bearer(owner.accessToken))
      .expect(200);
    await t.http.get('/v1/tenant').set(bearer(staff.accessToken)).expect(401);
    const list = await t.http.get('/v1/workspaces').set(bearer(staff.accessToken));
    expect(list.status).toBe(401);
  });
});

describe('cross-tenant reads and writes by id', () => {
  it('cannot read, change or delete another business’s members or invitations', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    const aStaff = await addMember(t, a, 'STAFF');
    const aMembers = (await t.http.get('/v1/members').set(bearer(a.accessToken))).body as {
      id: string;
      userId: string;
    }[];
    const target = aMembers.find((m) => m.userId === aStaff.user.id)!;
    const inv = (
      await t.http
        .post('/v1/members/invitations')
        .set(bearer(a.accessToken))
        .send({ email: uniqueEmail(), role: 'STAFF' })
        .expect(201)
    ).body;

    // writes by B against A's ids
    expect(
      (
        await t.http
          .patch(`/v1/members/${target.id}`)
          .set(bearer(b.accessToken))
          .send({ role: 'ADMIN' })
      ).status,
    ).toBe(404);
    expect(
      (await t.http.delete(`/v1/members/${target.id}`).set(bearer(b.accessToken))).status,
    ).toBe(404);
    expect(
      (await t.http.delete(`/v1/members/invitations/${inv.id}`).set(bearer(b.accessToken))).status,
    ).toBe(404);
    // reads by B never include A's people
    const bMembers = JSON.stringify(
      (await t.http.get('/v1/members').set(bearer(b.accessToken))).body,
    );
    expect(bMembers).not.toContain(aStaff.user.id);
    const bInvites = JSON.stringify(
      (await t.http.get('/v1/members/invitations').set(bearer(b.accessToken))).body,
    );
    expect(bInvites).not.toContain(inv.id);

    // A's data is untouched
    const after = (await t.http.get('/v1/members').set(bearer(a.accessToken))).body as {
      id: string;
      role: string;
    }[];
    expect(after.find((m) => m.id === target.id)?.role).toBe('STAFF');
    // nothing about A appears in B's audit trail
    expect(JSON.stringify(await audit(b.accessToken))).not.toContain(target.id);
  });

  it('keeps one business’s settings out of another’s reads', async () => {
    const a = await registerTenant(t, { tenantName: 'Secret Alpha' });
    const b = await registerTenant(t);
    await t.http
      .patch('/v1/tenant')
      .set(bearer(a.accessToken))
      .send({ contactEmail: 'private@alpha.test' })
      .expect(200);
    const seenByB = JSON.stringify(
      (
        await Promise.all([
          t.http.get('/v1/tenant').set(bearer(b.accessToken)),
          t.http.get('/v1/workspaces').set(bearer(b.accessToken)),
          t.http.get('/v1/me').set(bearer(b.accessToken)),
        ])
      ).map((r) => r.body),
    );
    expect(seenByB).not.toContain('Secret Alpha');
    expect(seenByB).not.toContain('private@alpha.test');
  });
});

describe('row-level security for the workspace list', () => {
  it('exposes only the user’s own memberships’ tenants when no business is selected', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    const rows = await t.db.withContext({ userId: a.user.id }, (tx) => tx.tenant.findMany());
    expect(rows.map((r) => r.id)).toEqual([a.tenant.id]);
    // without any context: nothing
    expect(await t.db.withContext({}, (tx) => tx.tenant.findMany())).toHaveLength(0);
    // a user context cannot write to a tenant it only reads through the member policy
    const updated = await t.db.withContext({ userId: a.user.id }, (tx) =>
      tx.tenant.updateMany({ where: { id: a.tenant.id }, data: { name: 'sneaky' } }),
    );
    expect(updated.count).toBe(0);
    void b;
  });
});

describe('preferences', () => {
  it('changes the caller’s own language only', async () => {
    const owner = await registerTenant(t);
    const staff = await addMember(t, owner, 'STAFF');
    const res = await t.http
      .patch('/v1/me')
      .set(bearer(staff.accessToken))
      .send({ language: 'bn' })
      .expect(200);
    expect(res.body.user.language).toBe('bn');
    expect((await t.http.get('/v1/me').set(bearer(owner.accessToken))).body.user.language).toBe(
      'en',
    );
    await t.http
      .patch('/v1/me')
      .set(bearer(staff.accessToken))
      .send({ language: 'fr' })
      .expect(400);
  });
});
