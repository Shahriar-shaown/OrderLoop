import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createProduct, createTestApp, registerTenant, type TestApp } from './app.js';
import { formatReport, verifyLedger } from '../src/inventory/ledger-check.js';
import { testEnv } from './test-env.js';

let t: TestApp;
let admin: pg.Client;
beforeAll(async () => {
  t = await createTestApp();
  // The check reads every business, so it uses the admin role (on the test database), like the real script.
  const url = new URL(testEnv.DATABASE_ADMIN_URL);
  url.pathname = new URL(testEnv.DATABASE_URL).pathname;
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
  await t.close();
});

describe('pnpm inventory:verify', () => {
  it('replays the ledger against the stock levels: clean when they agree, names the level that drifted', async () => {
    const owner = await registerTenant(t);
    const auth = bearer(owner.accessToken);
    const { variant } = await createProduct(t, owner.accessToken);
    await t.http
      .post('/v1/inventory/receive')
      .set(auth)
      .send({ variantId: variant.id, quantity: 10 })
      .expect(201);
    await t.http
      .post('/v1/inventory/adjust')
      .set(auth)
      .send({ variantId: variant.id, delta: -2, reason: 'recount' })
      .expect(201);
    await t.http
      .post('/v1/inventory/damage')
      .set(auth)
      .send({ variantId: variant.id, quantity: 1, reason: 'dropped' })
      .expect(201);
    await t.http
      .post('/v1/reservations')
      .set(auth)
      .send({ variantId: variant.id, quantity: 3 })
      .expect(201);

    const mine = (r: Awaited<ReturnType<typeof verifyLedger>>) =>
      r.drift.filter((d) => d.tenantId === owner.tenant.id);
    const clean = await verifyLedger(admin);
    expect(clean.movements).toBeGreaterThanOrEqual(4);
    expect(mine(clean)).toEqual([]);

    // someone edits the stock table by hand
    await admin.query(
      'UPDATE stock_levels SET on_hand = on_hand + 5 WHERE tenant_id = $1::uuid AND variant_id = $2::uuid',
      [owner.tenant.id, variant.id],
    );
    const drifted = await verifyLedger(admin);
    expect(mine(drifted)).toEqual([
      expect.objectContaining({
        variantId: variant.id,
        stored: { onHand: 12, reserved: 3, damaged: 1 },
        replayed: { onHand: 7, reserved: 3, damaged: 1 },
      }),
    ]);
    const lines = formatReport(drifted);
    expect(lines.some((l) => l.includes(`variant=${variant.id}`) && l.includes('onHand=12'))).toBe(
      true,
    );
    expect(lines.at(-1)).toMatch(/do not match the ledger/);

    // put it back: clean again
    await admin.query(
      'UPDATE stock_levels SET on_hand = on_hand - 5 WHERE tenant_id = $1::uuid AND variant_id = $2::uuid',
      [owner.tenant.id, variant.id],
    );
    expect(mine(await verifyLedger(admin))).toEqual([]);
    expect(formatReport(await verifyLedger(admin)).at(-1)).toMatch(/^(OK|\d+ of)/);
  });
  it('replays in numeric ledger order even where sequence numbers gain a digit (9999999998 < 10000000000)', async () => {
    const owner = await registerTenant(t);
    const auth = bearer(owner.accessToken);
    const { variant } = await createProduct(t, owner.accessToken);
    await t.http
      .post('/v1/inventory/receive')
      .set(auth)
      .send({ variantId: variant.id, quantity: 10 })
      .expect(201);
    const { rows } = await admin.query(
      'SELECT location_id FROM stock_levels WHERE tenant_id = $1::uuid AND variant_id = $2::uuid',
      [owner.tenant.id, variant.id],
    );
    const locationId = rows[0].location_id as string;
    // Net zero: +5, +5, -10. Sorted as text the -10 would come first and look like negative stock.
    const insert = (seq: string, type: string, delta: number) =>
      admin.query(
        `INSERT INTO stock_movements (id, tenant_id, variant_id, location_id, type, on_hand_delta, reserved_delta, seq)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::"StockMovementType", $5, 0, $6::bigint)`,
        [owner.tenant.id, variant.id, locationId, type, delta, seq],
      );
    try {
      await insert('9999999998', 'RECEIVE', 5);
      await insert('9999999999', 'RECEIVE', 5);
      await insert('10000000000', 'ADJUSTMENT', -10);
      const report = await verifyLedger(admin);
      expect(report.drift.filter((d) => d.tenantId === owner.tenant.id)).toEqual([]);
    } finally {
      await admin.query(
        'DELETE FROM stock_movements WHERE tenant_id = $1::uuid AND seq >= 9999999998',
        [owner.tenant.id],
      );
    }
  });
});
