import { findStalePendingImports } from '@orderloop/catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, registerTenant, type TestApp } from './app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe('finding imports that were saved but never queued', () => {
  it('finds old PENDING imports of every business, and only those', async () => {
    const [a, b] = [await registerTenant(t), await registerTenant(t)];
    const make = (tenantId: string, status: 'PENDING' | 'RUNNING' | 'COMPLETED', age: number) =>
      t.db.withContext({ tenantId }, (tx) =>
        tx.importJob.create({
          data: { tenantId, kind: 'products', csv: 'sku\n', status, createdAt: minutesAgo(age) },
          select: { id: true },
        }),
      );
    const staleA = await make(a.tenant.id, 'PENDING', 5);
    const staleB = await make(b.tenant.id, 'PENDING', 3);
    const young = await make(a.tenant.id, 'PENDING', 0);
    const running = await make(a.tenant.id, 'RUNNING', 5);
    const done = await make(b.tenant.id, 'COMPLETED', 5);

    const found = await findStalePendingImports(t.db, 60_000, 100_000);
    const ids = found.map((f) => f.importId);
    expect(ids).toEqual(expect.arrayContaining([staleA.id, staleB.id]));
    for (const other of [young, running, done]) expect(ids).not.toContain(other.id);
    // each comes with its own business, and never with the file
    expect(found.find((f) => f.importId === staleB.id)).toEqual({
      tenantId: b.tenant.id,
      importId: staleB.id,
    });
    expect(found.find((f) => f.importId === staleA.id)).toEqual({
      tenantId: a.tenant.id,
      importId: staleA.id,
    });
  });

  it('the cross-business read exists only for that one query: ordinary contexts still see nothing outside their own business', async () => {
    const [a, b] = [await registerTenant(t), await registerTenant(t)];
    await t.db.withContext({ tenantId: b.tenant.id }, (tx) =>
      tx.importJob.create({
        data: { tenantId: b.tenant.id, kind: 'products', csv: 'sku\n', createdAt: minutesAgo(5) },
      }),
    );
    expect(
      await t.db.withContext({ tenantId: a.tenant.id }, (tx) =>
        tx.importJob.count({ where: { tenantId: b.tenant.id } }),
      ),
    ).toBe(0);
    expect(await t.db.withContext({}, (tx) => tx.importJob.count())).toBe(0);
    // the one way across is the sweep function: it names ids only, and cannot be used to read anything else
    const rows = await t.db.withContext(
      {},
      (tx) =>
        tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM stale_pending_imports(60, 100000)`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['id', 'tenant_id']);
    // the old switch is gone: no setting opens any other row or table, and nothing can be written
    await t.db.withContext({}, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.sweep', 'import_jobs', true)`;
      expect(await tx.importJob.count()).toBe(0);
      expect(
        await tx.importJob.updateMany({ where: { status: 'PENDING' }, data: { status: 'FAILED' } }),
      ).toEqual({ count: 0 });
      expect(await tx.order.count()).toBe(0);
      expect(await tx.product.count()).toBe(0);
    });
    // and a business that looks for stale imports still sees only the answer the function gives, not rows
    await expect(
      t.db.withContext(
        { tenantId: a.tenant.id },
        (tx) => tx.$queryRaw`SELECT csv FROM stale_pending_imports(60, 10)`,
      ),
    ).rejects.toThrow();
  });
});
