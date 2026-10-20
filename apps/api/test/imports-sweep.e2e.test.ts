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
    // switching it on grants a read of PENDING rows only: no writes, and no other table
    await t.db.withContext({}, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.sweep', 'import_jobs', true)`;
      expect(await tx.importJob.count({ where: { status: 'RUNNING' } })).toBe(0);
      expect(
        await tx.importJob.updateMany({ where: { status: 'PENDING' }, data: { status: 'FAILED' } }),
      ).toEqual({ count: 0 });
      expect(await tx.order.count()).toBe(0);
    });
  });
});
