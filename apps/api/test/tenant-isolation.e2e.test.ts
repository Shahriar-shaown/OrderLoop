import { GLOBAL_TABLES, SYSTEM_TABLES, TENANT_TABLES } from '@orderloop/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createTestApp, PASSWORD, registerTenant, type TestApp } from './app.js';

/**
 * The mandatory tenant-isolation suite (architecture.md section 5). It attacks the database layer directly as the
 * runtime role (app_user) and through the HTTP API. A failure here is a data-leak bug, not a flaky test.
 */
let t: TestApp;
let a: Awaited<ReturnType<typeof registerTenant>>;
let b: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  t = await createTestApp();
  a = await registerTenant(t, { tenantName: 'Isolation A' });
  b = await registerTenant(t, { tenantName: 'Isolation B' });
  await addMember(t, a, 'STAFF');
  await addMember(t, b, 'MANAGER');
});
afterAll(() => t.close());

const ctxA = () => ({ tenantId: a.tenant.id });
const ctxB = () => ({ tenantId: b.tenant.id });

describe('database: fail closed without a context', () => {
  it('returns zero rows from every tenant table when no tenant is set', async () => {
    const counts = await t.db.withContext({}, async (tx) => ({
      tenants: await tx.tenant.count(),
      memberships: await tx.membership.count(),
      invitations: await tx.invitation.count(),
      audit: await tx.auditLog.count(),
    }));
    expect(counts).toEqual({ tenants: 0, memberships: 0, invitations: 0, audit: 0 });
  });

  it('rejects writes to tenant tables without a context', async () => {
    await expect(
      t.db.withContext({}, (tx) => tx.tenant.create({ data: { name: 'sneaky' } })),
    ).rejects.toThrow();
  });

  it('the unscoped global handle cannot see tenant data either (it is the same restricted role)', async () => {
    const rows = await t.db.global.user.count();
    expect(rows).toBeGreaterThan(0); // users are global by design
    const leaked = await (
      t.db.global as unknown as { membership: { count(): Promise<number> } }
    ).membership.count();
    expect(leaked).toBe(0);
  });

  it('refuses a malformed tenant id instead of passing it to SQL', async () => {
    await expect(
      t.db.withContext({ tenantId: "x'; DROP TABLE tenants;--" }, async () => 1),
    ).rejects.toThrow(/not a UUID/);
  });
});

describe('database: a tenant sees only itself', () => {
  it('reads exactly its own rows in every tenant table', async () => {
    const seen = await t.db.withContext(ctxA(), async (tx) => ({
      tenants: await tx.tenant.findMany(),
      memberships: await tx.membership.findMany(),
      audit: await tx.auditLog.findMany(),
      invitations: await tx.invitation.findMany(),
    }));
    expect(seen.tenants.map((x) => x.id)).toEqual([a.tenant.id]);
    expect(seen.memberships.length).toBeGreaterThanOrEqual(2);
    expect(seen.memberships.every((m) => m.tenantId === a.tenant.id)).toBe(true);
    expect(seen.audit.length).toBeGreaterThan(0);
    expect(seen.audit.every((r) => r.tenantId === a.tenant.id)).toBe(true);
    expect(seen.invitations.every((i) => i.tenantId === a.tenant.id)).toBe(true);
  });

  it("cannot read another tenant's row even by exact id", async () => {
    const bMembership = await t.db.withContext(ctxB(), (tx) => tx.membership.findFirstOrThrow());
    const leaked = await t.db.withContext(ctxA(), (tx) =>
      tx.membership.findUnique({ where: { id: bMembership.id } }),
    );
    expect(leaked).toBeNull();
    expect(
      await t.db.withContext(ctxA(), (tx) => tx.tenant.findUnique({ where: { id: b.tenant.id } })),
    ).toBeNull();
  });

  it("cannot update or delete another tenant's rows (zero rows affected)", async () => {
    const bMembership = await t.db.withContext(ctxB(), (tx) =>
      tx.membership.findFirstOrThrow({ where: { role: 'OWNER' } }),
    );
    const result = await t.db.withContext(ctxA(), async (tx) => ({
      updated: await tx.membership.updateMany({
        where: { id: bMembership.id },
        data: { role: 'STAFF' },
      }),
      deleted: await tx.membership.deleteMany({ where: { id: bMembership.id } }),
      tenantRenamed: await tx.tenant.updateMany({
        where: { id: b.tenant.id },
        data: { name: 'pwned' },
      }),
      tenantDeleted: await tx.tenant.deleteMany({ where: { id: b.tenant.id } }),
    }));
    expect(
      result.updated.count +
        result.deleted.count +
        result.tenantRenamed.count +
        result.tenantDeleted.count,
    ).toBe(0);
    const after = await t.db.withContext(ctxB(), (tx) =>
      tx.membership.findUniqueOrThrow({ where: { id: bMembership.id } }),
    );
    expect(after.role).toBe('OWNER');
    expect(
      (
        await t.db.withContext(ctxB(), (tx) =>
          tx.tenant.findUniqueOrThrow({ where: { id: b.tenant.id } }),
        )
      ).name,
    ).toBe('Isolation B');
  });

  it('cannot insert rows into another tenant (RLS WITH CHECK)', async () => {
    await expect(
      t.db.withContext(ctxA(), (tx) =>
        tx.membership.create({ data: { tenantId: b.tenant.id, userId: a.user.id, role: 'OWNER' } }),
      ),
    ).rejects.toThrow();
    await expect(
      t.db.withContext(ctxA(), (tx) =>
        tx.invitation.create({
          data: {
            tenantId: b.tenant.id,
            email: 'x@example.test',
            role: 'STAFF',
            tokenHash: 'h'.repeat(64),
            invitedById: a.user.id,
            expiresAt: new Date(Date.now() + 1000),
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      t.db.withContext(ctxA(), (tx) =>
        tx.auditLog.createMany({ data: [{ tenantId: b.tenant.id, action: 'forged' }] }),
      ),
    ).rejects.toThrow();
  });

  it('cannot move its own row to another tenant (UPDATE ... WITH CHECK)', async () => {
    const mine = await t.db.withContext(ctxA(), (tx) => tx.membership.findFirstOrThrow());
    await expect(
      t.db.withContext(ctxA(), (tx) =>
        tx.membership.update({ where: { id: mine.id }, data: { tenantId: b.tenant.id } }),
      ),
    ).rejects.toThrow();
  });

  it('a pooled connection never carries a previous tenant context (interleaved stress)', async () => {
    const jobs = Array.from({ length: 60 }, (_, i) => {
      const [own, other] = i % 2 === 0 ? [a, b] : [b, a];
      return t.db.withContext({ tenantId: own.tenant.id }, async (tx) => {
        const rows = await tx.membership.findMany({ select: { tenantId: true } });
        return {
          ok:
            rows.length > 0 &&
            rows.every((r) => r.tenantId === own.tenant.id) &&
            !rows.some((r) => r.tenantId === other.tenant.id),
        };
      });
    });
    const noContext = Array.from({ length: 20 }, () =>
      t.db.withContext({}, (tx) => tx.tenant.count()),
    );
    const results = await Promise.all([...jobs, ...noContext]);
    expect(results.slice(0, 60).every((r) => (r as { ok: boolean }).ok)).toBe(true);
    expect(results.slice(60).every((n) => n === 0)).toBe(true);
  });
});

describe('database: user-scoped membership visibility', () => {
  it('a user context can READ that user’s own memberships across tenants (login needs this)', async () => {
    const joined = await addMember(t, b, 'STAFF', { email: a.email });
    expect(joined.memberships).toHaveLength(2);
    const rows = await t.db.withContext({ userId: a.user.id }, (tx) => tx.membership.findMany());
    expect(rows.map((r) => r.tenantId).sort()).toEqual([a.tenant.id, b.tenant.id].sort());
    expect(rows.every((r) => r.userId === a.user.id)).toBe(true);
  });

  it('but a user context cannot write memberships or read other users’ rows', async () => {
    await expect(
      t.db.withContext({ userId: a.user.id }, (tx) =>
        tx.membership.create({ data: { tenantId: a.tenant.id, userId: a.user.id, role: 'OWNER' } }),
      ),
    ).rejects.toThrow();
    const others = await t.db.withContext({ userId: a.user.id }, (tx) =>
      tx.membership.findMany({ where: { userId: { not: a.user.id } } }),
    );
    expect(others).toEqual([]);
    const upd = await t.db.withContext({ userId: a.user.id }, (tx) =>
      tx.membership.updateMany({ data: { role: 'OWNER' } }),
    );
    expect(upd.count).toBe(0);
  });
});

describe('database: audit log is append-only', () => {
  it('allows inserts (including tenant-less events) but never update or delete', async () => {
    await t.db.withContext(ctxA(), (tx) =>
      tx.auditLog.createMany({ data: [{ tenantId: a.tenant.id, action: 'test.event' }] }),
    );
    await t.db.withContext({}, (tx) =>
      tx.auditLog.createMany({ data: [{ tenantId: null, action: 'test.tenantless' }] }),
    );
    await expect(
      t.db.withContext(ctxA(), (tx) => tx.auditLog.updateMany({ data: { action: 'tampered' } })),
    ).rejects.toThrow(/permission denied/i);
    await expect(t.db.withContext(ctxA(), (tx) => tx.auditLog.deleteMany({}))).rejects.toThrow(
      /permission denied/i,
    );
    // tenant-less events are never readable by the application
    const visible = await t.db.withContext(ctxA(), (tx) =>
      tx.auditLog.findMany({ where: { action: 'test.tenantless' } }),
    );
    expect(visible).toEqual([]);
  });
});

describe('database: schema guard rails', () => {
  it('every table is classified, so a new table cannot silently skip isolation review', async () => {
    const tables = await t.db.withContext(
      {},
      (tx) =>
        tx.$queryRaw<
          { tablename: string }[]
        >`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const known = new Set<string>([...TENANT_TABLES, ...GLOBAL_TABLES, ...SYSTEM_TABLES]);
    const unclassified = tables.map((r) => r.tablename).filter((n) => !known.has(n));
    expect(
      unclassified,
      `Unclassified tables: add them to packages/db/src/tables.ts and give tenant tables RLS`,
    ).toEqual([]);
  });

  it('every tenant table has row-level security enabled AND forced', async () => {
    const rows = await t.db.withContext(
      {},
      (tx) =>
        tx.$queryRaw<
          { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
    );
    for (const table of TENANT_TABLES) {
      const row = rows.find((r) => r.relname === table);
      expect(row, `${table} missing`).toBeDefined();
      expect(row, `${table} must ENABLE ROW LEVEL SECURITY`).toMatchObject({
        relrowsecurity: true,
      });
      expect(row, `${table} must FORCE ROW LEVEL SECURITY`).toMatchObject({
        relforcerowsecurity: true,
      });
    }
  });

  it('every tenant table has at least one policy', async () => {
    const policies = await t.db.withContext(
      {},
      (tx) =>
        tx.$queryRaw<
          { tablename: string }[]
        >`SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'`,
    );
    for (const table of TENANT_TABLES) expect(policies.map((p) => p.tablename)).toContain(table);
  });

  it('every tenant-owned table (other than tenants itself) has a tenant_id column', async () => {
    const cols = await t.db.withContext(
      {},
      (tx) =>
        tx.$queryRaw<
          { table_name: string }[]
        >`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
    );
    for (const table of TENANT_TABLES.filter((n) => n !== 'tenants'))
      expect(cols.map((c) => c.table_name)).toContain(table);
  });

  it('the runtime role cannot bypass RLS, own the tables, or change the schema', async () => {
    const [role] = await t.db.withContext(
      {},
      (tx) =>
        tx.$queryRaw<
          {
            rolsuper: boolean;
            rolbypassrls: boolean;
            rolcreaterole: boolean;
            rolcreatedb: boolean;
          }[]
        >`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
    const owners = await t.db.withContext(
      {},
      (tx) =>
        tx.$queryRaw<
          { tablename: string }[]
        >`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`,
    );
    expect(owners).toEqual([]);
    await expect(
      t.db.withContext({}, (tx) =>
        tx.$executeRawUnsafe('ALTER TABLE tenants DISABLE ROW LEVEL SECURITY'),
      ),
    ).rejects.toThrow(/must be owner/i);
    await expect(
      t.db.withContext({}, (tx) => tx.$executeRawUnsafe('SET ROLE app_migrator')),
    ).rejects.toThrow();
  });

  it('the runtime role cannot touch migration bookkeeping', async () => {
    await expect(
      t.db.withContext({}, (tx) => tx.$queryRawUnsafe('SELECT * FROM _prisma_migrations')),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('API: tenants cannot reach each other', () => {
  it('lists only its own members and audit entries', async () => {
    const aMembers = (await t.http.get('/v1/members').set(bearer(a.accessToken))).body as {
      userId: string;
    }[];
    const bMembers = (await t.http.get('/v1/members').set(bearer(b.accessToken))).body as {
      userId: string;
    }[];
    const bIds = new Set(bMembers.map((m) => m.userId));
    // `a` was added to b in an earlier test, so it legitimately appears in both; b's owner must not appear in a.
    expect(aMembers.some((m) => m.userId === b.user.id)).toBe(false);
    expect(bIds.has(b.user.id)).toBe(true);

    const aAudit = (await t.http.get('/v1/audit-logs?limit=100').set(bearer(a.accessToken))).body
      .items as { id: string }[];
    const bAudit = (await t.http.get('/v1/audit-logs?limit=100').set(bearer(b.accessToken))).body
      .items as { id: string }[];
    const bAuditIds = new Set(bAudit.map((i) => i.id));
    expect(aAudit.some((i) => bAuditIds.has(i.id))).toBe(false);
  });

  it("returns 404 (not 403) for another tenant's member id on read-modify routes, so ids cannot be probed", async () => {
    const bOwner = (await t.http.get('/v1/members').set(bearer(b.accessToken))).body.find(
      (m: { userId: string }) => m.userId === b.user.id,
    ) as { id: string };
    const patch = await t.http
      .patch(`/v1/members/${bOwner.id}`)
      .set(bearer(a.accessToken))
      .send({ role: 'STAFF' });
    const del = await t.http.delete(`/v1/members/${bOwner.id}`).set(bearer(a.accessToken));
    const missing = await t.http
      .delete('/v1/members/0197b0a0-0000-7000-8000-00000000dead')
      .set(bearer(a.accessToken));
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
    expect(patch.body.code).toBe(missing.body.code);
    const still = (await t.http.get('/v1/members').set(bearer(b.accessToken))).body.find(
      (m: { id: string }) => m.id === bOwner.id,
    );
    expect(still.role).toBe('OWNER');
  });

  it('an access token cannot be pointed at another tenant by editing its claims', async () => {
    const [h, p, s] = a.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, unknown>;
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, tid: b.tenant.id })).toString('base64url')}.${s}`;
    expect((await t.http.get('/v1/tenant').set(bearer(forged))).status).toBe(401);
  });

  it('GET /v1/tenant only ever returns the caller’s tenant', async () => {
    expect((await t.http.get('/v1/tenant').set(bearer(a.accessToken))).body.id).toBe(a.tenant.id);
    expect((await t.http.get('/v1/tenant').set(bearer(b.accessToken))).body.id).toBe(b.tenant.id);
  });

  it('an invitation from tenant B cannot be accepted into tenant A or read from A', async () => {
    const email = `cross-${Date.now()}@example.test`;
    await t.http
      .post('/v1/members/invitations')
      .set(bearer(b.accessToken))
      .send({ email, role: 'STAFF' })
      .expect(201);
    const token = t.mail.tokenFor(email, 'invitation');
    expect(token.split('_')[1]).toBe(b.tenant.id); // the token names the tenant it belongs to
    const seenByA = await t.db.withContext(ctxA(), (tx) =>
      tx.invitation.findMany({ where: { email } }),
    );
    expect(seenByA).toEqual([]);
    const accepted = await t.http
      .post('/v1/auth/accept-invitation')
      .send({ token, name: 'Cross', password: PASSWORD });
    expect(accepted.body.tenant.id).toBe(b.tenant.id);
  });
});
