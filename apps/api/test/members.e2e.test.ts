import { Reflector, DiscoveryService } from '@nestjs/core';
import { routes } from '@orderloop/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE_SPEC } from '../src/common/endpoint.js';
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

describe('role-based access', () => {
  it('enforces the permission matrix on every protected route', async () => {
    const owner = await registerTenant(t);
    const staff = await addMember(t, owner, 'STAFF');
    const accountant = await addMember(t, owner, 'ACCOUNTANT');
    const manager = await addMember(t, owner, 'MANAGER');
    const admin = await addMember(t, owner, 'ADMIN');

    const status = async (
      who: { accessToken: string },
      method: 'get' | 'post',
      path: string,
      body?: object,
    ) => (await t.http[method](path).set(bearer(who.accessToken)).send(body)).status;

    // STAFF: tenant only
    expect(await status(staff, 'get', '/v1/tenant')).toBe(200);
    expect(await status(staff, 'get', '/v1/members')).toBe(403);
    expect(await status(staff, 'get', '/v1/audit-logs')).toBe(403);
    expect(
      await status(staff, 'post', '/v1/members/invitations', {
        email: uniqueEmail(),
        role: 'STAFF',
      }),
    ).toBe(403);
    // MANAGER and ACCOUNTANT: can list members, cannot invite or read audit
    for (const who of [manager, accountant]) {
      expect(await status(who, 'get', '/v1/members')).toBe(200);
      expect(await status(who, 'get', '/v1/audit-logs')).toBe(403);
      expect(
        await status(who, 'post', '/v1/members/invitations', {
          email: uniqueEmail(),
          role: 'STAFF',
        }),
      ).toBe(403);
    }
    // ADMIN and OWNER: everything
    for (const who of [admin, owner]) {
      expect(await status(who, 'get', '/v1/members')).toBe(200);
      expect(await status(who, 'get', '/v1/audit-logs')).toBe(200);
    }
  });

  it('uses the role stored in the database, not the one baked into the token', async () => {
    const owner = await registerTenant(t);
    const admin = await addMember(t, owner, 'ADMIN');
    expect((await t.http.get('/v1/audit-logs').set(bearer(admin.accessToken))).status).toBe(200);

    const members = (await t.http.get('/v1/members').set(bearer(owner.accessToken))).body as {
      id: string;
      email: string;
    }[];
    const adminMembership = members.find((m) => m.email === admin.email)!;
    await t.http
      .patch(`/v1/members/${adminMembership.id}`)
      .set(bearer(owner.accessToken))
      .send({ role: 'STAFF' })
      .expect(200);

    // Same token, demoted role: takes effect immediately.
    expect((await t.http.get('/v1/audit-logs').set(bearer(admin.accessToken))).status).toBe(403);
  });

  it('removing a member cuts off their existing access token immediately', async () => {
    const owner = await registerTenant(t);
    const staff = await addMember(t, owner, 'STAFF');
    const members = (await t.http.get('/v1/members').set(bearer(owner.accessToken))).body as {
      id: string;
      email: string;
    }[];
    await t.http
      .delete(`/v1/members/${members.find((m) => m.email === staff.email)!.id}`)
      .set(bearer(owner.accessToken))
      .expect(200);
    expect((await t.http.get('/v1/tenant').set(bearer(staff.accessToken))).status).toBe(401);
    expect(
      (await t.http.post('/v1/auth/refresh').send({ refreshToken: staff.refreshToken })).status,
    ).toBe(401);
  });
});

describe('privilege escalation is blocked', () => {
  it('an ADMIN cannot invite owners or admins, nor promote anyone to them', async () => {
    const owner = await registerTenant(t);
    const admin = await addMember(t, owner, 'ADMIN');
    const staff = await addMember(t, owner, 'STAFF');
    for (const role of ['OWNER', 'ADMIN']) {
      expect(
        (
          await t.http
            .post('/v1/members/invitations')
            .set(bearer(admin.accessToken))
            .send({ email: uniqueEmail(), role })
        ).status,
      ).toBe(403);
    }
    const members = (await t.http.get('/v1/members').set(bearer(owner.accessToken))).body as {
      id: string;
      email: string;
    }[];
    const id = (email: string) => members.find((m) => m.email === email)!.id;
    expect(
      (
        await t.http
          .patch(`/v1/members/${id(staff.email)}`)
          .set(bearer(admin.accessToken))
          .send({ role: 'OWNER' })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.http
          .patch(`/v1/members/${id(owner.email)}`)
          .set(bearer(admin.accessToken))
          .send({ role: 'STAFF' })
      ).status,
    ).toBe(403);
    expect(
      (await t.http.delete(`/v1/members/${id(owner.email)}`).set(bearer(admin.accessToken))).status,
    ).toBe(403);
    expect(
      (
        await t.http
          .patch(`/v1/members/${id(staff.email)}`)
          .set(bearer(admin.accessToken))
          .send({ role: 'MANAGER' })
      ).status,
    ).toBe(200);
  });

  it('a tenant always keeps at least one owner', async () => {
    const owner = await registerTenant(t);
    const me = (await t.http.get('/v1/members').set(bearer(owner.accessToken))).body[0] as {
      id: string;
    };
    const demote = await t.http
      .patch(`/v1/members/${me.id}`)
      .set(bearer(owner.accessToken))
      .send({ role: 'ADMIN' });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('last_owner');
    expect(
      (await t.http.delete(`/v1/members/${me.id}`).set(bearer(owner.accessToken))).status,
    ).toBe(409);

    const second = await addMember(t, owner, 'OWNER');
    expect(
      (
        await t.http
          .patch(`/v1/members/${me.id}`)
          .set(bearer(second.accessToken))
          .send({ role: 'ADMIN' })
      ).status,
    ).toBe(200);
    // Now `second` is the only owner again.
    const secondMembership = (
      await t.http.get('/v1/members').set(bearer(second.accessToken))
    ).body.find((m: { email: string }) => m.email === second.email) as { id: string };
    expect(
      (await t.http.delete(`/v1/members/${secondMembership.id}`).set(bearer(second.accessToken)))
        .status,
    ).toBe(409);
  });

  it('two owners demoting each other at the same time cannot leave the tenant ownerless', async () => {
    // Run several rounds: the interleaving differs each time, the invariant must not.
    for (let round = 0; round < 5; round++) {
      const first = await registerTenant(t);
      const second = await addMember(t, first, 'OWNER');
      const members = (await t.http.get('/v1/members').set(bearer(first.accessToken))).body as {
        id: string;
        email: string;
      }[];
      const id = (email: string) => members.find((m) => m.email === email)!.id;
      const results = await Promise.all([
        t.http
          .patch(`/v1/members/${id(second.email)}`)
          .set(bearer(first.accessToken))
          .send({ role: 'ADMIN' }),
        t.http
          .patch(`/v1/members/${id(first.email)}`)
          .set(bearer(second.accessToken))
          .send({ role: 'ADMIN' }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses[0]).toBe(200); // one demotion wins
      expect([403, 409]).toContain(statuses[1]); // the other is refused (stale actor role, or last owner)
      const survivor = results[0].status === 200 ? first : second;
      const owners = (
        await t.http.get('/v1/members').set(bearer(survivor.accessToken))
      ).body.filter((m: { role: string }) => m.role === 'OWNER');
      expect(owners).toHaveLength(1);
    }
  });
});

describe('invitations', () => {
  it('creates an account for a new person, who can then sign in', async () => {
    const owner = await registerTenant(t);
    const email = uniqueEmail('newbie');
    await t.http
      .post('/v1/members/invitations')
      .set(bearer(owner.accessToken))
      .send({ email, role: 'MANAGER' })
      .expect(201);
    const sent = t.invites.sent.findLast((m) => m.email === email)!;
    expect(sent.link).toContain('/accept-invitation?token=');

    const accepted = await t.http
      .post('/v1/auth/accept-invitation')
      .send({ token: sent.token, name: 'New Person', password: PASSWORD });
    expect(accepted.status).toBe(201);
    expect(accepted.body.role).toBe('MANAGER');
    expect(accepted.body.tenant.id).toBe(owner.tenant.id);
    expect((await t.http.post('/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(
      200,
    );
  });

  it('does not reveal the token to the inviter', async () => {
    const owner = await registerTenant(t);
    const res = await t.http
      .post('/v1/members/invitations')
      .set(bearer(owner.accessToken))
      .send({ email: uniqueEmail(), role: 'STAFF' });
    expect(JSON.stringify(res.body)).not.toContain('inv_');
    const row = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.invitation.findFirstOrThrow({ where: { tenantId: owner.tenant.id } }),
    );
    expect(row.tokenHash).toHaveLength(64);
  });

  it('is single-use', async () => {
    const owner = await registerTenant(t);
    const email = uniqueEmail();
    await t.http
      .post('/v1/members/invitations')
      .set(bearer(owner.accessToken))
      .send({ email, role: 'STAFF' });
    const { token } = t.invites.sent.findLast((m) => m.email === email)!;
    await t.http
      .post('/v1/auth/accept-invitation')
      .send({ token, name: 'A', password: PASSWORD })
      .expect(201);
    const again = await t.http
      .post('/v1/auth/accept-invitation')
      .send({ token, name: 'A', password: PASSWORD });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('invitation_invalid');
  });

  it('a newer invitation revokes the older one', async () => {
    const owner = await registerTenant(t);
    const email = uniqueEmail();
    await t.http
      .post('/v1/members/invitations')
      .set(bearer(owner.accessToken))
      .send({ email, role: 'STAFF' });
    const old = t.invites.sent.findLast((m) => m.email === email)!.token;
    await t.http
      .post('/v1/members/invitations')
      .set(bearer(owner.accessToken))
      .send({ email, role: 'MANAGER' });
    expect(
      (
        await t.http
          .post('/v1/auth/accept-invitation')
          .send({ token: old, name: 'A', password: PASSWORD })
      ).status,
    ).toBe(400);
  });

  it('rejects expired, forged and cross-tenant-tampered tokens', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    const email = uniqueEmail();
    await t.http
      .post('/v1/members/invitations')
      .set(bearer(a.accessToken))
      .send({ email, role: 'STAFF' });
    const { token } = t.invites.sent.findLast((m) => m.email === email)!;

    const swapped = token.replace(a.tenant.id, b.tenant.id); // point the same secret at another tenant
    expect(
      (
        await t.http
          .post('/v1/auth/accept-invitation')
          .send({ token: swapped, name: 'A', password: PASSWORD })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.http
          .post('/v1/auth/accept-invitation')
          .send({ token: 'inv_nonsense', name: 'A', password: PASSWORD })
      ).status,
    ).toBe(400);

    await t.db.withContext({ tenantId: a.tenant.id }, (tx) =>
      tx.invitation.updateMany({
        where: { tenantId: a.tenant.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );
    expect(
      (
        await t.http
          .post('/v1/auth/accept-invitation')
          .send({ token, name: 'A', password: PASSWORD })
      ).status,
    ).toBe(400);
  });

  it('an existing user must prove their password to accept', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    await t.http
      .post('/v1/members/invitations')
      .set(bearer(b.accessToken))
      .send({ email: a.email, role: 'STAFF' });
    const { token } = t.invites.sent.findLast((m) => m.email === a.email)!;
    expect(
      (await t.http.post('/v1/auth/accept-invitation').send({ token, password: 'not my password' }))
        .status,
    ).toBe(401);
    expect(
      (await t.http.post('/v1/auth/accept-invitation').send({ token, password: PASSWORD })).status,
    ).toBe(201);
  });

  it('cannot invite someone who is already a member', async () => {
    const owner = await registerTenant(t);
    const res = await t.http
      .post('/v1/members/invitations')
      .set(bearer(owner.accessToken))
      .send({ email: owner.email, role: 'STAFF' });
    expect(res.status).toBe(409);
  });
});

describe('invitations carry their inviter’s authority', () => {
  const invite = async (who: { accessToken: string }, email: string, role: string) => {
    await t.http
      .post('/v1/members/invitations')
      .set(bearer(who.accessToken))
      .send({ email, role })
      .expect(201);
    return t.invites.sent.findLast((m) => m.email === email)!.token;
  };
  const memberId = async (owner: { accessToken: string }, email: string) =>
    (
      (await t.http.get('/v1/members').set(bearer(owner.accessToken))).body as {
        id: string;
        email: string;
      }[]
    ).find((m) => m.email === email)!.id;

  it('removing the inviter voids their pending invitations', async () => {
    const owner = await registerTenant(t);
    const admin = await addMember(t, owner, 'ADMIN');
    const sneaky = uniqueEmail('sneaky');
    const token = await invite(admin, sneaky, 'MANAGER'); // an admin invites an address they control
    await t.http
      .delete(`/v1/members/${await memberId(owner, admin.email)}`)
      .set(bearer(owner.accessToken))
      .expect(200);
    const res = await t.http
      .post('/v1/auth/accept-invitation')
      .send({ token, name: 'S', password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invitation_invalid');
  });

  it('demoting the inviter voids their pending invitations', async () => {
    const owner = await registerTenant(t);
    const admin = await addMember(t, owner, 'ADMIN');
    const token = await invite(admin, uniqueEmail('pending'), 'MANAGER');
    await t.http
      .patch(`/v1/members/${await memberId(owner, admin.email)}`)
      .set(bearer(owner.accessToken))
      .send({ role: 'STAFF' })
      .expect(200);
    expect(
      (
        await t.http
          .post('/v1/auth/accept-invitation')
          .send({ token, name: 'P', password: PASSWORD })
      ).status,
    ).toBe(400);
  });

  it('acceptance re-checks the inviter even if no cleanup ran (defence in depth)', async () => {
    const owner = await registerTenant(t);
    const admin = await addMember(t, owner, 'ADMIN');
    const email = uniqueEmail('late');
    const token = await invite(admin, email, 'MANAGER');
    // Remove the inviter behind the API's back, so only the accept-time check can catch it.
    await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.membership.deleteMany({ where: { user: { email: admin.email } } }),
    );
    expect(
      (
        await t.http
          .post('/v1/auth/accept-invitation')
          .send({ token, name: 'L', password: PASSWORD })
      ).status,
    ).toBe(400);
    const row = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.invitation.findFirstOrThrow({ where: { email } }),
    );
    expect(row.revokedAt).not.toBeNull();
    expect(row.acceptedAt).toBeNull();
  });

  it('can be listed and revoked, and a revoked invitation cannot be accepted', async () => {
    const owner = await registerTenant(t);
    const email = uniqueEmail('revokeme');
    const token = await invite(owner, email, 'STAFF');
    const pending = (await t.http.get('/v1/members/invitations').set(bearer(owner.accessToken)))
      .body as { id: string; email: string }[];
    const mine = pending.find((i) => i.email === email)!;
    expect(mine).toBeDefined();
    expect(JSON.stringify(pending)).not.toContain('inv_');

    await t.http
      .delete(`/v1/members/invitations/${mine.id}`)
      .set(bearer(owner.accessToken))
      .expect(200);
    expect(
      (await t.http.get('/v1/members/invitations').set(bearer(owner.accessToken))).body.some(
        (i: { email: string }) => i.email === email,
      ),
    ).toBe(false);
    expect(
      (
        await t.http
          .post('/v1/auth/accept-invitation')
          .send({ token, name: 'R', password: PASSWORD })
      ).status,
    ).toBe(400);
    expect(
      (await t.http.delete(`/v1/members/invitations/${mine.id}`).set(bearer(owner.accessToken)))
        .status,
    ).toBe(404);
  });

  it('an admin cannot revoke an invitation for a role they could not grant; other roles cannot touch invitations', async () => {
    const owner = await registerTenant(t);
    const admin = await addMember(t, owner, 'ADMIN');
    const staff = await addMember(t, owner, 'STAFF');
    await invite(owner, uniqueEmail('future-admin'), 'ADMIN');
    const pending = (await t.http.get('/v1/members/invitations').set(bearer(owner.accessToken)))
      .body as { id: string; role: string }[];
    const adminInvite = pending.find((i) => i.role === 'ADMIN')!;
    expect(
      (
        await t.http
          .delete(`/v1/members/invitations/${adminInvite.id}`)
          .set(bearer(admin.accessToken))
      ).status,
    ).toBe(403);
    expect(
      (await t.http.get('/v1/members/invitations').set(bearer(staff.accessToken))).status,
    ).toBe(403);
    expect(
      (
        await t.http
          .delete(`/v1/members/invitations/${adminInvite.id}`)
          .set(bearer(staff.accessToken))
      ).status,
    ).toBe(403);
  });
});

describe('audit trail', () => {
  it('records security-relevant events and paginates newest first', async () => {
    const owner = await registerTenant(t);
    await addMember(t, owner, 'STAFF');
    await t.http.post('/v1/auth/login').send({ email: owner.email, password: PASSWORD });

    const all = (await t.http.get('/v1/audit-logs?limit=100').set(bearer(owner.accessToken))).body;
    const actions = all.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'tenant.created',
        'auth.register',
        'member.invited',
        'member.joined',
        'auth.login',
      ]),
    );
    expect(all.nextCursor).toBeNull();

    const page1 = (await t.http.get('/v1/audit-logs?limit=2').set(bearer(owner.accessToken))).body;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (
      await t.http
        .get(`/v1/audit-logs?limit=2&cursor=${page1.nextCursor}`)
        .set(bearer(owner.accessToken))
    ).body;
    const ids = [...page1.items, ...page2.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(all.items[0].id);
    expect(ids[2]).toBe(all.items[2].id);
  });

  it('records token reuse in the tenant audit log', async () => {
    const owner = await registerTenant(t);
    await t.http.post('/v1/auth/refresh').send({ refreshToken: owner.refreshToken });
    await t.http.post('/v1/auth/refresh').send({ refreshToken: owner.refreshToken });
    const login = await t.http
      .post('/v1/auth/login')
      .send({ email: owner.email, password: PASSWORD });
    const log = (await t.http.get('/v1/audit-logs?limit=100').set(bearer(login.body.accessToken)))
      .body;
    expect(log.items.map((i: { action: string }) => i.action)).toContain(
      'auth.token_reuse_detected',
    );
  });
});

describe('route registry', () => {
  it('every controller handler is bound to a registry entry, and every entry has a handler', () => {
    const discovery = t.app.get(DiscoveryService);
    const reflector = t.app.get(Reflector);
    const bound = new Set<string>();
    for (const wrapper of discovery.getControllers()) {
      const proto = Object.getPrototypeOf(wrapper.instance) as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const spec = reflector.get<{ id: string } | undefined>(
          ROUTE_SPEC,
          handler as () => unknown,
        );
        if (spec) bound.add(spec.id);
      }
    }
    expect([...bound].sort()).toEqual(Object.keys(routes).sort());
  });
});
