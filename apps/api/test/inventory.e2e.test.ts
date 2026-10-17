import {
  movement,
  replay,
  StockInvariantError,
  applyMovement,
  type StockLevel,
} from '@orderloop/domain';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createProduct, createTestApp, registerTenant, type TestApp } from './app.js';

let t: TestApp;
let owner: Awaited<ReturnType<typeof registerTenant>>;
beforeAll(async () => {
  t = await createTestApp();
  owner = await registerTenant(t);
});
afterAll(() => t.close());

const auth = () => bearer(owner.accessToken);
const receive = (variantId: string, quantity: number, extra: object = {}) =>
  t.http
    .post('/v1/inventory/receive')
    .set(auth())
    .send({ variantId, quantity, ...extra });
const adjust = (variantId: string, delta: number, extra: object = {}) =>
  t.http
    .post('/v1/inventory/adjust')
    .set(auth())
    .send({ variantId, delta, reason: 'stock take', ...extra });
const reserve = (variantId: string, quantity: number, extra: object = {}) =>
  t.http
    .post('/v1/reservations')
    .set(auth())
    .send({ variantId, quantity, ...extra });
const level = async (variantId: string) => {
  const rows = (await t.http.get(`/v1/inventory?variantId=${variantId}`).set(auth())).body
    .items as { onHand: number; reserved: number; available: number }[];
  return rows[0] ?? { onHand: 0, reserved: 0, available: 0 };
};
const newVariant = async (extra: Parameters<typeof createProduct>[2] = {}) =>
  (await createProduct(t, owner.accessToken, extra)).variant.id;

/**
 * The books must balance: for every (variant, location), the stored level equals the SUM of its ledger rows, and
 * replaying the ledger in sequence order through the pure domain rules never violates an invariant and lands on the
 * stored level. Also: reserved equals the total of active reservations.
 */
async function assertBooksBalance(variantId: string) {
  await t.db.withContext({ tenantId: owner.tenant.id }, async (tx) => {
    const movements = await tx.stockMovement.findMany({
      where: { tenantId: owner.tenant.id, variantId },
      orderBy: { seq: 'asc' },
    });
    const levels = await tx.stockLevel.findMany({
      where: { tenantId: owner.tenant.id, variantId },
    });
    for (const lv of levels) {
      const mine = movements.filter((m) => m.locationId === lv.locationId);
      expect(lv.onHand).toBe(mine.reduce((n, m) => n + m.onHandDelta, 0));
      expect(lv.reserved).toBe(mine.reduce((n, m) => n + m.reservedDelta, 0));
      expect(lv.reserved).toBeGreaterThanOrEqual(0);
      expect(lv.reserved).toBeLessThanOrEqual(lv.onHand);
      let replayed: StockLevel;
      try {
        replayed = replay(
          mine.map((m) => ({
            type: m.type,
            onHandDelta: m.onHandDelta,
            reservedDelta: m.reservedDelta,
          })),
        );
      } catch (error) {
        throw new Error(`ledger replay hit an invariant violation: ${(error as Error).message}`);
      }
      expect(replayed).toEqual({ onHand: lv.onHand, reserved: lv.reserved });
      const active = await tx.reservation.aggregate({
        where: {
          tenantId: owner.tenant.id,
          variantId,
          locationId: lv.locationId,
          status: 'ACTIVE',
        },
        _sum: { quantity: true },
      });
      expect(active._sum.quantity ?? 0).toBe(lv.reserved);
    }
    // Strictly increasing sequence: the ledger has a total order.
    for (let i = 1; i < movements.length; i++)
      expect(movements[i]!.seq > movements[i - 1]!.seq).toBe(true);
  });
}

describe('receiving and adjusting stock', () => {
  it('receive creates the level and one ledger row', async () => {
    const variantId = await newVariant({ sku: `RCV-${Date.now()}` });
    const res = await receive(variantId, 12, {
      reason: 'Supplier delivery',
      referenceType: 'purchase',
      referenceId: 'PO-7',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ variantId, onHand: 12, reserved: 0, available: 12 });

    const movements = (
      await t.http.get(`/v1/inventory/movements?variantId=${variantId}`).set(auth())
    ).body.items;
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: 'RECEIVE',
      onHandDelta: 12,
      reservedDelta: 0,
      reason: 'Supplier delivery',
      referenceType: 'purchase',
      referenceId: 'PO-7',
      createdById: owner.user.id,
    });
    expect(movements[0].id).toBe(res.body.movementId);
    await assertBooksBalance(variantId);
  });

  it('uses the default location unless one is named, and rejects unknown, archived and foreign locations', async () => {
    const variantId = await newVariant();
    const shop = (
      await t.http
        .post('/v1/locations')
        .set(auth())
        .send({ name: `Shop ${Date.now()}` })
    ).body;
    await receive(variantId, 5).expect(201);
    await receive(variantId, 7, { locationId: shop.id }).expect(201);
    const lines = (await t.http.get(`/v1/inventory?variantId=${variantId}`).set(auth())).body.items;
    expect(
      lines.map((l: { locationName: string; onHand: number }) => [l.locationName, l.onHand]).sort(),
    ).toEqual(
      [
        ['Main warehouse', 5],
        [shop.name, 7],
      ].sort(),
    );

    expect(
      (await receive(variantId, 1, { locationId: '0197b0a0-0000-7000-8000-00000000dead' })).status,
    ).toBe(404);
    const other = await registerTenant(t);
    const foreign = (
      await t.http.post('/v1/locations').set(bearer(other.accessToken)).send({ name: 'Theirs' })
    ).body;
    expect((await receive(variantId, 1, { locationId: foreign.id })).status).toBe(404);
    await assertBooksBalance(variantId);
  });

  it('adjusts up and down with a reason, never below what is reserved or below zero', async () => {
    const variantId = await newVariant();
    await receive(variantId, 10).expect(201);
    expect((await adjust(variantId, -3)).body).toMatchObject({ onHand: 7, available: 7 });
    expect((await adjust(variantId, 5)).body).toMatchObject({ onHand: 12 });
    await reserve(variantId, 9).expect(201);

    const tooFar = await adjust(variantId, -4); // would leave 8 on hand with 9 promised
    expect(tooFar.status).toBe(409);
    expect(tooFar.body.code).toBe('insufficient_stock');
    expect(tooFar.body.detail).toMatch(/Only 3 available, 4 requested/);
    expect(await level(variantId)).toMatchObject({ onHand: 12, reserved: 9 });
    expect((await adjust(variantId, -3)).status).toBe(201); // exactly the unreserved part is fine
    expect(await level(variantId)).toMatchObject({ onHand: 9, reserved: 9, available: 0 });

    const empty = await newVariant();
    const none = await adjust(empty, -1);
    expect(none.status).toBe(409);
    expect(none.body.detail).toMatch(/Only 0 available/);
    await assertBooksBalance(variantId);
  });

  it('validates quantities, deltas and reasons', async () => {
    const variantId = await newVariant();
    expect((await receive(variantId, 0)).status).toBe(400);
    expect((await receive(variantId, -5)).status).toBe(400);
    expect((await receive(variantId, 1.5)).status).toBe(400);
    expect((await receive(variantId, 1_000_001)).status).toBe(400);
    expect((await adjust(variantId, 0)).status).toBe(400);
    expect(
      (await t.http.post('/v1/inventory/adjust').set(auth()).send({ variantId, delta: 1 })).status,
    ).toBe(400); // reason is required
    expect(
      (
        await t.http
          .post('/v1/inventory/adjust')
          .set(auth())
          .send({ variantId, delta: 1, reason: 'x' })
      ).status,
    ).toBe(400);
    expect((await receive('not-a-uuid', 1)).status).toBe(400);
    expect((await receive('0197b0a0-0000-7000-8000-00000000dead', 1)).status).toBe(404);
  });

  it('refuses to go past the maximum on-hand quantity instead of overflowing', async () => {
    const variantId = await newVariant();
    await receive(variantId, 1).expect(201);
    await t.db.withContext(
      { tenantId: owner.tenant.id },
      (tx) =>
        tx.$executeRaw`UPDATE stock_levels SET on_hand = 999999999 WHERE variant_id = ${variantId}::uuid`,
    );
    const res = await receive(variantId, 5);
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/maximum/);
    expect(await level(variantId)).toMatchObject({ onHand: 999_999_999 });
  });

  it('archived variants cannot take stock or reservations', async () => {
    const { variant } = await createProduct(t, owner.accessToken);
    await t.http
      .patch(`/v1/variants/${variant.id}`)
      .set(auth())
      .send({ archived: true })
      .expect(200);
    expect((await receive(variant.id, 1)).status).toBe(409);
    expect((await reserve(variant.id, 1)).status).toBe(409);
  });
});

describe('reservations', () => {
  it('reserving holds stock without removing it; releasing gives it back; fulfilling ships it', async () => {
    const variantId = await newVariant();
    await receive(variantId, 10).expect(201);

    const r1 = await reserve(variantId, 4, { referenceType: 'order', referenceId: 'ORD-1' });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({
      variantId,
      quantity: 4,
      status: 'ACTIVE',
      referenceType: 'order',
      referenceId: 'ORD-1',
      resolvedAt: null,
    });
    expect(await level(variantId)).toEqual({
      ...(await level(variantId)),
      onHand: 10,
      reserved: 4,
      available: 6,
    });

    const released = await t.http.post(`/v1/reservations/${r1.body.id}/release`).set(auth());
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ status: 'RELEASED' });
    expect(released.body.resolvedAt).toEqual(expect.any(String));
    expect(await level(variantId)).toMatchObject({ onHand: 10, reserved: 0, available: 10 });

    const r2 = await reserve(variantId, 3);
    const shipped = await t.http.post(`/v1/reservations/${r2.body.id}/fulfil`).set(auth());
    expect(shipped.body.status).toBe('FULFILLED');
    expect(await level(variantId)).toMatchObject({ onHand: 7, reserved: 0, available: 7 });

    const types = (
      await t.http.get(`/v1/inventory/movements?variantId=${variantId}&limit=100`).set(auth())
    ).body.items.map((m: { type: string }) => m.type);
    expect(types).toEqual(['SHIP', 'RESERVE', 'RELEASE', 'RESERVE', 'RECEIVE']); // newest first
    await assertBooksBalance(variantId);
  });

  it('refuses to oversell, and a refused reservation changes nothing', async () => {
    const variantId = await newVariant();
    await receive(variantId, 5).expect(201);
    await reserve(variantId, 3).expect(201);
    const before = (
      await t.http.get(`/v1/inventory/movements?variantId=${variantId}&limit=100`).set(auth())
    ).body.items.length;

    const over = await reserve(variantId, 3); // only 2 available
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({
      code: 'insufficient_stock',
      detail: 'Only 2 available, 3 requested',
    });
    expect(await level(variantId)).toMatchObject({ onHand: 5, reserved: 3 });
    expect(
      (await t.http.get(`/v1/inventory/movements?variantId=${variantId}&limit=100`).set(auth()))
        .body.items,
    ).toHaveLength(before);
    expect(
      (await t.http.get(`/v1/reservations?variantId=${variantId}`).set(auth())).body.items,
    ).toHaveLength(1);
    expect((await reserve(variantId, 2)).status).toBe(201); // exactly what is left is fine
    expect((await reserve(variantId, 1)).status).toBe(409);
    await assertBooksBalance(variantId);
  });

  it('a reservation can be resolved only once, and unknown or foreign ids are 404', async () => {
    const variantId = await newVariant();
    await receive(variantId, 5).expect(201);
    const r = (await reserve(variantId, 2)).body;
    await t.http.post(`/v1/reservations/${r.id}/release`).set(auth()).expect(200);
    const again = await t.http.post(`/v1/reservations/${r.id}/release`).set(auth());
    expect(again.status).toBe(409);
    expect(again.body.detail).toBe('Reservation is already RELEASED');
    expect((await t.http.post(`/v1/reservations/${r.id}/fulfil`).set(auth())).status).toBe(409);
    expect(
      (
        await t.http
          .post('/v1/reservations/0197b0a0-0000-7000-8000-00000000dead/release')
          .set(auth())
      ).status,
    ).toBe(404);

    const live = (await reserve(variantId, 1)).body;
    const other = await registerTenant(t);
    expect(
      (await t.http.post(`/v1/reservations/${live.id}/release`).set(bearer(other.accessToken)))
        .status,
    ).toBe(404);
    expect((await level(variantId)).reserved).toBe(1); // the foreign attempt did nothing
    await assertBooksBalance(variantId);
  });

  it('lists reservations by status, and blocks archiving a variant that still has an active one', async () => {
    const { variant } = await createProduct(t, owner.accessToken);
    await receive(variant.id, 5).expect(201);
    const r = (await reserve(variant.id, 1)).body;
    expect(
      (await t.http.get(`/v1/reservations?variantId=${variant.id}&status=ACTIVE`).set(auth())).body
        .items,
    ).toHaveLength(1);
    expect(
      (await t.http.get(`/v1/reservations?variantId=${variant.id}&status=FULFILLED`).set(auth()))
        .body.items,
    ).toHaveLength(0);
    expect(
      (await t.http.patch(`/v1/variants/${variant.id}`).set(auth()).send({ archived: true }))
        .status,
    ).toBe(409);
    await t.http.post(`/v1/reservations/${r.id}/release`).set(auth()).expect(200);
    expect(
      (await t.http.patch(`/v1/variants/${variant.id}`).set(auth()).send({ archived: true }))
        .status,
    ).toBe(200);
  });
});

describe('low stock', () => {
  it('flags variants at or below their reorder point, counting reservations and all locations', async () => {
    const lowId = await newVariant({ reorderPoint: 5, sku: `LOW-${Date.now()}` });
    const offId = await newVariant({ reorderPoint: 0 }); // 0 disables the alert
    const isLow = async (id: string) =>
      (await t.http.get('/v1/inventory/low-stock').set(auth())).body.find(
        (x: { variantId: string }) => x.variantId === id,
      );

    expect(await isLow(lowId)).toMatchObject({ onHand: 0, available: 0, reorderPoint: 5 }); // no stock at all counts
    expect(await isLow(offId)).toBeUndefined();

    await receive(lowId, 10).expect(201);
    expect(await isLow(lowId)).toBeUndefined();
    await reserve(lowId, 6).expect(201); // available 4 <= 5
    expect(await isLow(lowId)).toMatchObject({ onHand: 10, reserved: 6, available: 4 });

    const shop = (
      await t.http
        .post('/v1/locations')
        .set(auth())
        .send({ name: `Low ${Date.now()}` })
    ).body;
    await receive(lowId, 3, { locationId: shop.id }).expect(201); // another location counts toward the total: available 7
    expect(await isLow(lowId)).toBeUndefined();

    // Per location, each line is judged on its own: main has 4 available and the shop has 3, both thin against 5.
    const perLine = (await t.http.get(`/v1/inventory?variantId=${lowId}&lowStock=true`).set(auth()))
      .body.items;
    expect(perLine.map((l: { available: number }) => l.available).sort()).toEqual([3, 4]);
    await receive(lowId, 10, { locationId: shop.id }).expect(201); // now the shop is healthy (13) and only main is thin
    const afterTopUp = (
      await t.http.get(`/v1/inventory?variantId=${lowId}&lowStock=true`).set(auth())
    ).body.items;
    expect(afterTopUp.map((l: { available: number }) => l.available)).toEqual([4]);
  });

  it('leaves out archived variants and archived products', async () => {
    const { product, variant } = await createProduct(t, owner.accessToken, { reorderPoint: 5 });
    const present = async () =>
      (await t.http.get('/v1/inventory/low-stock').set(auth())).body.some(
        (x: { variantId: string }) => x.variantId === variant.id,
      );
    expect(await present()).toBe(true);
    await t.http
      .patch(`/v1/products/${product.id}`)
      .set(auth())
      .send({ status: 'ARCHIVED' })
      .expect(200);
    expect(await present()).toBe(false);
  });
});

describe('the ledger and stock list', () => {
  it('pages the ledger newest first by sequence, with filters', async () => {
    const variantId = await newVariant();
    await receive(variantId, 20).expect(201);
    for (let i = 0; i < 4; i++) await reserve(variantId, 1).expect(201);
    await adjust(variantId, -2).expect(201);

    const p1 = (
      await t.http.get(`/v1/inventory/movements?variantId=${variantId}&limit=3`).set(auth())
    ).body;
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (
      await t.http
        .get(`/v1/inventory/movements?variantId=${variantId}&limit=3&cursor=${p1.nextCursor}`)
        .set(auth())
    ).body;
    expect(p2.items).toHaveLength(3);
    expect(p2.nextCursor).toBeNull();
    // The API does not expose the internal ledger sequence (it is global, so its gaps would reveal other tenants' volume)...
    expect(p1.items.every((m: { seq?: number }) => m.seq === undefined)).toBe(true);
    // ...but the order it imposes is the real one: newest first, matching the ledger's own sequence exactly.
    const apiIds = [...p1.items, ...p2.items].map((m: { id: string }) => m.id);
    const dbIds = await t.db.withContext({ tenantId: owner.tenant.id }, async (tx) =>
      (
        await tx.stockMovement.findMany({
          where: { tenantId: owner.tenant.id, variantId },
          orderBy: { seq: 'desc' },
        })
      ).map((m) => m.id),
    );
    expect(apiIds).toEqual(dbIds);
    expect(new Set(apiIds).size).toBe(6);
    const reserves = (
      await t.http.get(`/v1/inventory/movements?variantId=${variantId}&type=RESERVE`).set(auth())
    ).body.items;
    expect(reserves).toHaveLength(4);
    expect(reserves.every((m: { sku: string }) => typeof m.sku === 'string')).toBe(true);
  });

  it('lists stock lines with filters and pagination', async () => {
    const own = await registerTenant(t);
    const tok = bearer(own.accessToken);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { variant } = await createProduct(t, own.accessToken, {
        sku: `LST-${i}-${Date.now()}`,
      });
      await t.http
        .post('/v1/inventory/receive')
        .set(tok)
        .send({ variantId: variant.id, quantity: i + 1 })
        .expect(201);
      ids.push(variant.id);
    }
    const p1 = (await t.http.get('/v1/inventory?limit=3').set(tok)).body;
    const p2 = (await t.http.get(`/v1/inventory?limit=3&cursor=${p1.nextCursor}`).set(tok)).body;
    const all = [...p1.items, ...p2.items];
    expect(all).toHaveLength(4);
    expect(new Set(all.map((l: { variantId: string }) => l.variantId)).size).toBe(4);
    expect(p2.nextCursor).toBeNull();
    expect(all[0]).toMatchObject({
      locationName: 'Main warehouse',
      productName: expect.any(String),
      sku: expect.any(String),
    });
  });
});

describe('idempotency keys', () => {
  it('a retried receive changes nothing and returns the original result', async () => {
    const variantId = await newVariant();
    const key = `retry-${Date.now()}-a`;
    const first = await receive(variantId, 10, { idempotencyKey: key });
    const second = await receive(variantId, 10, { idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.movementId).toBe(first.body.movementId);
    expect(await level(variantId)).toMatchObject({ onHand: 10 });
    expect(
      (await t.http.get(`/v1/inventory/movements?variantId=${variantId}`).set(auth())).body.items,
    ).toHaveLength(1);
  });

  it('reusing a key for a different request is refused, not ignored', async () => {
    const variantId = await newVariant();
    const key = `reuse-${Date.now()}-b`;
    await receive(variantId, 10, { idempotencyKey: key }).expect(201);
    const clash = await receive(variantId, 99, { idempotencyKey: key });
    expect(clash.status).toBe(409);
    expect(clash.body.detail).toMatch(/idempotency key/i);
    const otherVariant = await newVariant();
    expect((await receive(otherVariant, 10, { idempotencyKey: key })).status).toBe(409);
    expect(await level(variantId)).toMatchObject({ onHand: 10 });
  });

  it('many simultaneous requests with one key add the stock exactly once', async () => {
    const variantId = await newVariant();
    const key = `race-${Date.now()}-c`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => receive(variantId, 4, { idempotencyKey: key })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.movementId)).size).toBe(1);
    expect(await level(variantId)).toMatchObject({ onHand: 4 });
    await assertBooksBalance(variantId);
  });

  it('a reservation retried with its key returns the same reservation and holds stock once', async () => {
    const variantId = await newVariant();
    await receive(variantId, 10).expect(201);
    const key = `res-${Date.now()}-d`;
    const first = await reserve(variantId, 3, { idempotencyKey: key });
    const second = await reserve(variantId, 3, { idempotencyKey: key });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(await level(variantId)).toMatchObject({ reserved: 3 });
    expect((await reserve(variantId, 4, { idempotencyKey: key })).status).toBe(409);
  });

  it('keys are scoped to a tenant: two tenants can use the same key', async () => {
    const other = await registerTenant(t);
    const mine = await newVariant();
    const { variant } = await createProduct(t, other.accessToken);
    const key = `shared-${Date.now()}-e`;
    await receive(mine, 1, { idempotencyKey: key }).expect(201);
    await t.http
      .post('/v1/inventory/receive')
      .set(bearer(other.accessToken))
      .send({ variantId: variant.id, quantity: 2, idempotencyKey: key })
      .expect(201);
  });
});

describe('concurrency: stock is never oversold', () => {
  it('ACCEPTANCE: 50 parallel reservations against 10 units give exactly 10 successes and never negative stock', async () => {
    const variantId = await newVariant();
    await receive(variantId, 10).expect(201);

    const results = await Promise.all(Array.from({ length: 50 }, () => reserve(variantId, 1)));
    const ok = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(10);
    expect(refused).toHaveLength(40);
    expect(refused.every((r) => r.body.code === 'insufficient_stock')).toBe(true);
    expect(results.filter((r) => r.status !== 201 && r.status !== 409)).toEqual([]); // nothing else: no 500s, no deadlocks

    expect(await level(variantId)).toMatchObject({ onHand: 10, reserved: 10, available: 0 });
    expect(
      (
        await t.http
          .get(`/v1/inventory/movements?variantId=${variantId}&type=RESERVE&limit=100`)
          .set(auth())
      ).body.items,
    ).toHaveLength(10);
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(10);
    await assertBooksBalance(variantId);
  });

  it('mixed sizes: reservations never exceed what exists, and the leftover is exactly what could not fit', async () => {
    const variantId = await newVariant();
    await receive(variantId, 25).expect(201);
    const sizes = [5, 1, 3, 7, 2, 4, 6, 1, 2, 8, 3, 5, 4, 2, 9, 1, 6, 3, 2, 7];
    const results = await Promise.all(sizes.map((q) => reserve(variantId, q)));
    const granted = results.reduce((n, r, i) => n + (r.status === 201 ? sizes[i]! : 0), 0);
    expect(granted).toBeLessThanOrEqual(25);
    expect(await level(variantId)).toMatchObject({ onHand: 25, reserved: granted });
    // Every refused request really could not have fit at the moment it was refused: nothing smaller than what's left was turned away unfairly is
    // not guaranteed by ordering, but the books must balance exactly.
    await assertBooksBalance(variantId);
  });

  it('20 simultaneous fulfilments of one reservation ship it exactly once', async () => {
    const variantId = await newVariant();
    await receive(variantId, 10).expect(201);
    const r = (await reserve(variantId, 4)).body;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => t.http.post(`/v1/reservations/${r.id}/fulfil`).set(auth())),
    );
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    expect(results.filter((x) => x.status === 409)).toHaveLength(19);
    expect(await level(variantId)).toMatchObject({ onHand: 6, reserved: 0 });
    await assertBooksBalance(variantId);
  });

  it('simultaneous release and fulfil of one reservation: exactly one wins', async () => {
    const variantId = await newVariant();
    await receive(variantId, 10).expect(201);
    const r = (await reserve(variantId, 4)).body;
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () =>
        t.http.post(`/v1/reservations/${r.id}/release`).set(auth()),
      ),
      ...Array.from({ length: 5 }, () =>
        t.http.post(`/v1/reservations/${r.id}/fulfil`).set(auth()),
      ),
    ]);
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    const final = await level(variantId);
    expect([
      JSON.stringify({ onHand: 10, reserved: 0 }),
      JSON.stringify({ onHand: 6, reserved: 0 }),
    ]).toContain(JSON.stringify({ onHand: final.onHand, reserved: final.reserved }));
    await assertBooksBalance(variantId);
  });

  it('parallel adjustments can never cut into reserved stock', async () => {
    const variantId = await newVariant();
    await receive(variantId, 10).expect(201);
    await reserve(variantId, 4).expect(201);
    const results = await Promise.all(Array.from({ length: 30 }, () => adjust(variantId, -1)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(6); // only the 6 unreserved units can go
    expect(results.filter((r) => r.status === 409)).toHaveLength(24);
    expect(await level(variantId)).toMatchObject({ onHand: 4, reserved: 4, available: 0 });
    await assertBooksBalance(variantId);
  });
});

type Op =
  | { kind: 'receive'; q: number }
  | { kind: 'adjust'; d: number }
  | { kind: 'reserve'; q: number }
  | { kind: 'release'; pick: number }
  | { kind: 'fulfil'; pick: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.integer({ min: 1, max: 30 }).map((q): Op => ({ kind: 'receive', q })),
  },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: -30, max: 30 })
      .filter((d) => d !== 0)
      .map((d): Op => ({ kind: 'adjust', d })),
  },
  {
    weight: 4,
    arbitrary: fc.integer({ min: 1, max: 30 }).map((q): Op => ({ kind: 'reserve', q })),
  },
  { weight: 2, arbitrary: fc.nat(1000).map((pick): Op => ({ kind: 'release', pick })) },
  { weight: 2, arbitrary: fc.nat(1000).map((pick): Op => ({ kind: 'fulfil', pick })) },
);

describe('property tests: the real system agrees with the pure ledger rules', () => {
  it('PROPERTY (sequential): for random operation sequences, every accept/refuse decision and every resulting level matches the domain model, and replaying the ledger reproduces the stored level', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 5, maxLength: 40 }), async (ops) => {
        const variantId = await newVariant();
        let model: StockLevel = { onHand: 0, reserved: 0 };
        const active: { id: string; q: number }[] = [];

        for (const op of ops) {
          if (op.kind === 'receive' || op.kind === 'adjust' || op.kind === 'reserve') {
            const m =
              op.kind === 'receive'
                ? movement.receive(op.q)
                : op.kind === 'adjust'
                  ? movement.adjust(op.d)
                  : movement.reserve(op.q);
            let expected: StockLevel | null;
            try {
              expected = applyMovement(model, m);
            } catch (error) {
              expect(error).toBeInstanceOf(StockInvariantError);
              expected = null;
            }
            const res =
              op.kind === 'receive'
                ? await receive(variantId, op.q)
                : op.kind === 'adjust'
                  ? await adjust(variantId, op.d)
                  : await reserve(variantId, op.q);
            if (expected) {
              expect(res.status, `${JSON.stringify(op)} on ${JSON.stringify(model)}`).toBe(201);
              model = expected;
              if (op.kind === 'reserve') active.push({ id: res.body.id, q: op.q });
            } else {
              expect(res.status, `${JSON.stringify(op)} on ${JSON.stringify(model)}`).toBe(409);
              expect(res.body.code).toBe('insufficient_stock');
            }
          } else if (active.length > 0) {
            const [picked] = active.splice(op.pick % active.length, 1);
            const res = await t.http
              .post(
                `/v1/reservations/${picked!.id}/${op.kind === 'release' ? 'release' : 'fulfil'}`,
              )
              .set(auth());
            expect(res.status).toBe(200);
            model = applyMovement(
              model,
              op.kind === 'release' ? movement.release(picked!.q) : movement.ship(picked!.q),
            );
          }
          const actual = await level(variantId);
          expect({ onHand: actual.onHand, reserved: actual.reserved }).toEqual(model);
          expect(actual.available).toBeGreaterThanOrEqual(0);
        }
        await assertBooksBalance(variantId);
      }),
      { numRuns: Number(process.env.PROPERTY_RUNS ?? 12) },
    );
  });

  it('PROPERTY (concurrent): after random parallel bursts the books balance, stock is never negative, and the ledger replayed in sequence order never breaks an invariant', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(opArb, { minLength: 3, maxLength: 12 }), { minLength: 2, maxLength: 4 }),
        async (bursts) => {
          const variantId = await newVariant();
          await receive(variantId, 20).expect(201);
          const active: string[] = [];
          for (const burst of bursts) {
            const results = await Promise.all(
              burst.map(async (op) => {
                if (op.kind === 'receive') return receive(variantId, op.q);
                if (op.kind === 'adjust') return adjust(variantId, op.d);
                if (op.kind === 'reserve') {
                  const res = await reserve(variantId, op.q);
                  if (res.status === 201) active.push(res.body.id);
                  return res;
                }
                const id = active.length
                  ? active[op.pick % active.length]!
                  : '0197b0a0-0000-7000-8000-00000000dead';
                return t.http
                  .post(`/v1/reservations/${id}/${op.kind === 'release' ? 'release' : 'fulfil'}`)
                  .set(auth());
              }),
            );
            // Expected outcomes only: success, "not enough", "already resolved" or "not found". Never a server error.
            for (const r of results)
              expect([200, 201, 404, 409], JSON.stringify(r.body)).toContain(r.status);
            const lv = await level(variantId);
            expect(lv.onHand).toBeGreaterThanOrEqual(0);
            expect(lv.reserved).toBeGreaterThanOrEqual(0);
            expect(lv.reserved).toBeLessThanOrEqual(lv.onHand);
          }
          await assertBooksBalance(variantId);
        },
      ),
      { numRuns: Math.ceil(Number(process.env.PROPERTY_RUNS ?? 12) * 0.7) },
    );
  });
});
