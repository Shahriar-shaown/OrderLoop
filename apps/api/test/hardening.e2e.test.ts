import { failImportJob, processImportJob } from '@orderloop/catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_IMPORTS_IN_FLIGHT } from '../src/imports/imports.service.js';
import { bearer, createProduct, createTestApp, registerTenant, type TestApp } from './app.js';

/**
 * Regression tests for the problems found by the independent review of Phase 2: each test fails against the code as it
 * was before the fix.
 */
let t: TestApp;
let owner: Awaited<ReturnType<typeof registerTenant>>;
beforeAll(async () => {
  t = await createTestApp();
  owner = await registerTenant(t);
});
afterAll(() => t.close());

const auth = () => bearer(owner.accessToken);
const stamp = Date.now();
const HEADER =
  'product_name,sku,price,category,unit,variant_name,cost,reorder_point,opening_stock,location';

describe('archiving cannot race with stock changes', () => {
  it('a location is never both archived and given stock, however the requests interleave', async () => {
    const { variant } = await createProduct(t, owner.accessToken);
    for (let round = 0; round < 25; round++) {
      const loc = (
        await t.http
          .post('/v1/locations')
          .set(auth())
          .send({ name: `Race ${stamp}-${round}` })
      ).body.id as string;
      const [archive, receive] = await Promise.all([
        t.http.patch(`/v1/locations/${loc}`).set(auth()).send({ archived: true }),
        t.http
          .post('/v1/inventory/receive')
          .set(auth())
          .send({ variantId: variant.id, locationId: loc, quantity: 5 }),
      ]);
      // Exactly one of the two may win. Both succeeding would strand stock in an archived location.
      expect(
        archive.status === 200 && receive.status === 201,
        `round ${round}: archive ${archive.status}, receive ${receive.status}`,
      ).toBe(false);
      expect([200, 409]).toContain(archive.status);
      expect([201, 404]).toContain(receive.status);
      const row = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
        tx.stockLocation.findUniqueOrThrow({ where: { id: loc } }),
      );
      const stock = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
        tx.stockLevel.findFirst({ where: { locationId: loc } }),
      );
      if (row.archivedAt) expect(stock?.onHand ?? 0).toBe(0);
    }
  });

  it('a variant is never both archived and holding an active reservation', async () => {
    for (let round = 0; round < 25; round++) {
      const { variant } = await createProduct(t, owner.accessToken);
      await t.http
        .post('/v1/inventory/receive')
        .set(auth())
        .send({ variantId: variant.id, quantity: 10 })
        .expect(201);
      const [archive, reserve] = await Promise.all([
        t.http.patch(`/v1/variants/${variant.id}`).set(auth()).send({ archived: true }),
        t.http.post('/v1/reservations').set(auth()).send({ variantId: variant.id, quantity: 1 }),
      ]);
      expect(
        archive.status === 200 && reserve.status === 201,
        `round ${round}: archive ${archive.status}, reserve ${reserve.status}`,
      ).toBe(false);
      expect([200, 409]).toContain(archive.status);
      expect([201, 409]).toContain(reserve.status);
    }
  });
});

describe('the default location', () => {
  it('ten simultaneous first uses create exactly one location and put all the stock in it', async () => {
    const own = await registerTenant(t);
    const { variant } = await createProduct(t, own.accessToken);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        t.http
          .post('/v1/inventory/receive')
          .set(bearer(own.accessToken))
          .send({ variantId: variant.id, quantity: 3 }),
      ),
    );
    expect(
      results.every((r) => r.status === 201),
      JSON.stringify(results.map((r) => r.status)),
    ).toBe(true);
    const locations = (await t.http.get('/v1/locations').set(bearer(own.accessToken))).body;
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ name: 'Main warehouse', isDefault: true });
    const lines = (
      await t.http.get(`/v1/inventory?variantId=${variant.id}`).set(bearer(own.accessToken))
    ).body.items;
    expect(lines).toHaveLength(1);
    expect(lines[0].onHand).toBe(30);
  });

  it('a location created first becomes the default, instead of being shadowed by an invented one', async () => {
    const own = await registerTenant(t);
    const tok = bearer(own.accessToken);
    // The owner's own location is even called "Main warehouse", but is not the default.
    const mine = (await t.http.post('/v1/locations').set(tok).send({ name: 'Main warehouse' }))
      .body;
    expect(mine.isDefault).toBe(false);
    const { variant } = await createProduct(t, own.accessToken);
    await t.http
      .post('/v1/inventory/receive')
      .set(tok)
      .send({ variantId: variant.id, quantity: 4 })
      .expect(201);
    const locations = (await t.http.get('/v1/locations').set(tok)).body;
    expect(locations).toHaveLength(1); // nothing extra was invented
    expect(locations[0]).toMatchObject({ id: mine.id, isDefault: true });
    expect(
      (await t.http.get(`/v1/inventory?variantId=${variant.id}`).set(tok)).body.items[0],
    ).toMatchObject({ locationId: mine.id, onHand: 4 });
  });

  it('after the default is archived, the next oldest active location takes over', async () => {
    const own = await registerTenant(t);
    const tok = bearer(own.accessToken);
    const a = (await t.http.post('/v1/locations').set(tok).send({ name: 'First', isDefault: true }))
      .body;
    const b = (await t.http.post('/v1/locations').set(tok).send({ name: 'Second' })).body;
    await t.http.patch(`/v1/locations/${b.id}`).set(tok).send({ isDefault: true }).expect(200);
    await t.http.patch(`/v1/locations/${a.id}`).set(tok).send({ archived: true }).expect(200);
    const { variant } = await createProduct(t, own.accessToken);
    await t.http
      .post('/v1/inventory/receive')
      .set(tok)
      .send({ variantId: variant.id, quantity: 1 })
      .expect(201);
    expect(
      (await t.http.get(`/v1/inventory?variantId=${variant.id}`).set(tok)).body.items[0].locationId,
    ).toBe(b.id);
  });
});

describe('idempotency keys and where the stock went', () => {
  it('a key reused with a different location is refused, not replayed', async () => {
    const own = await registerTenant(t);
    const tok = bearer(own.accessToken);
    const { variant } = await createProduct(t, own.accessToken);
    const shop = (await t.http.post('/v1/locations').set(tok).send({ name: 'Shop' })).body
      .id as string;
    const annex = (await t.http.post('/v1/locations').set(tok).send({ name: 'Annex' })).body
      .id as string;
    const key = `loc-${stamp}-key-1`;
    await t.http
      .post('/v1/inventory/receive')
      .set(tok)
      .send({ variantId: variant.id, locationId: shop, quantity: 5, idempotencyKey: key })
      .expect(201);
    const clash = await t.http
      .post('/v1/inventory/receive')
      .set(tok)
      .send({ variantId: variant.id, locationId: annex, quantity: 5, idempotencyKey: key });
    expect(clash.status).toBe(409);
    expect(clash.body.detail).toMatch(/idempotency key/i);
    const same = await t.http
      .post('/v1/inventory/receive')
      .set(tok)
      .send({ variantId: variant.id, locationId: shop, quantity: 5, idempotencyKey: key });
    expect(same.status).toBe(201); // the genuine retry still replays
  });
});

describe('archived products', () => {
  it('cannot take stock or reservations, even though their variants are not archived', async () => {
    const { product, variant } = await createProduct(t, owner.accessToken);
    await t.http
      .post('/v1/inventory/receive')
      .set(auth())
      .send({ variantId: variant.id, quantity: 5 })
      .expect(201);
    await t.http
      .patch(`/v1/products/${product.id}`)
      .set(auth())
      .send({ status: 'ARCHIVED' })
      .expect(200);
    const recv = await t.http
      .post('/v1/inventory/receive')
      .set(auth())
      .send({ variantId: variant.id, quantity: 1 });
    expect(recv.status).toBe(409);
    expect(recv.body.detail).toMatch(/product is archived/);
    expect(
      (
        await t.http
          .post('/v1/reservations')
          .set(auth())
          .send({ variantId: variant.id, quantity: 1 })
      ).status,
    ).toBe(409);
    await t.http
      .patch(`/v1/products/${product.id}`)
      .set(auth())
      .send({ status: 'ACTIVE' })
      .expect(200);
    expect(
      (
        await t.http
          .post('/v1/inventory/receive')
          .set(auth())
          .send({ variantId: variant.id, quantity: 1 })
      ).status,
    ).toBe(201);
  });

  it('an import row cannot add variants to an archived product', async () => {
    const { product } = await createProduct(t, owner.accessToken, {
      name: `Archived Import ${stamp}`,
      sku: `ARCH-${stamp}-1`,
    });
    await t.http
      .patch(`/v1/products/${product.id}`)
      .set(auth())
      .send({ status: 'ARCHIVED' })
      .expect(200);
    const job = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.importJob.create({
        data: {
          tenantId: owner.tenant.id,
          kind: 'products',
          createdById: owner.user.id,
          csv: `${HEADER}\nArchived Import ${stamp},ARCH-${stamp}-2,10,,pcs,,,,,`,
        },
      }),
    );
    await processImportJob(t.db, { tenantId: owner.tenant.id, importId: job.id });
    const done = (await t.http.get(`/v1/imports/${job.id}`).set(auth())).body;
    expect(done).toMatchObject({ status: 'COMPLETED', created: 0, failed: 1 });
    expect(done.errors[0].message).toMatch(/is archived/);
  });
});

describe('read endpoints', () => {
  it('malformed cursors never cause a server error', async () => {
    const bad = [
      'x',
      '-'.repeat(36),
      'e30',
      Buffer.from('{"t":"nope","id":"----"}').toString('base64url'),
      Buffer.from('{"a":"1","b":"2"}').toString('base64url'),
      Buffer.from('{"s":"-5"}').toString('base64url'),
      '%00',
    ];
    for (const path of [
      '/v1/products',
      '/v1/inventory',
      '/v1/inventory/movements',
      '/v1/reservations',
      '/v1/audit-logs',
    ]) {
      for (const cursor of bad) {
        const res = await t.http.get(`${path}?cursor=${encodeURIComponent(cursor)}`).set(auth());
        expect(res.status, `${path} cursor=${cursor}`).toBe(200);
      }
    }
  });

  it('listing locations does not create anything, and does not need a write permission', async () => {
    const own = await registerTenant(t);
    const accountant = await (async () => {
      const { addMember } = await import('./app.js');
      return addMember(t, own, 'ACCOUNTANT');
    })();
    expect((await t.http.get('/v1/locations').set(bearer(accountant.accessToken))).body).toEqual(
      [],
    );
    const count = await t.db.withContext({ tenantId: own.tenant.id }, (tx) =>
      tx.stockLocation.count(),
    );
    expect(count).toBe(0);
  });
});

describe('request bodies', () => {
  it('an oversized body is 413 problem details, not a server error', async () => {
    const res = await t.http
      .post('/v1/products')
      .set(auth())
      .send({ name: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.body).toMatchObject({
      status: 413,
      code: 'validation_failed',
      detail: 'The request body is too large',
    });
    const login = await t.http
      .post('/v1/auth/login')
      .send({ email: 'a@b.test', password: 'x'.repeat(200_000) });
    expect(login.status).toBe(413);
  });

  it('invalid JSON is a 400 that does not echo the body back', async () => {
    const res = await t.http
      .post('/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{"email": "SECRET-IN-BODY", broken');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-IN-BODY');
    expect(res.body.detail).toBe('The request body is not valid JSON');
  });

  it('the large import allowance is only for callers who present a token: anonymous callers are turned away before the body is read', async () => {
    const big = 'x'.repeat(1_500_000);
    // The server answers 401 and hangs up without reading the megabyte; the client may see that as a reset mid-upload.
    const anonymous = await t.http
      .post('/v1/imports/products')
      .send({ csv: big })
      .then(
        (res) => res,
        (error: NodeJS.ErrnoException) => {
          expect(['ECONNRESET', 'EPIPE']).toContain(error.code);
          return null;
        },
      );
    if (anonymous) {
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.code).toBe('unauthorized');
    }
    expect(
      await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
        tx.importJob.count({ where: { csv: { startsWith: 'xxxx' } } }),
      ),
    ).toBe(0);
    // A signed-in user may send a large (but valid, under 2 MB) CSV.
    const own = await registerTenant(t);
    const ok = await t.http
      .post('/v1/imports/products')
      .set(bearer(own.accessToken))
      .send({ csv: `${HEADER}\n${'a,'.repeat(3)}` });
    expect(ok.status).toBe(202);
    // ...but not more than the CSV limit.
    const tooBig = await t.http
      .post('/v1/imports/products')
      .set(bearer(own.accessToken))
      .send({ csv: 'x'.repeat(2_500_000) });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.errors[0].path).toBe('body.csv');
  });
});

describe('import fairness and recovery', () => {
  it(`a business may have at most ${MAX_IMPORTS_IN_FLIGHT} imports in flight, and others are unaffected`, async () => {
    const quiet = await createTestApp(
      {},
      { queue: { add: async () => undefined, close: async () => undefined } },
    ); // no worker: jobs stay queued
    try {
      const a = await registerTenant(quiet);
      const b = await registerTenant(quiet);
      const submit = (who: typeof a) =>
        quiet.http
          .post('/v1/imports/products')
          .set(bearer(who.accessToken))
          .send({ csv: `${HEADER}\nX,FAIR-${stamp},1,,,,,,,` });
      const first: { status: number; body: { id: string } }[] = [];
      for (let i = 0; i < MAX_IMPORTS_IN_FLIGHT; i++) first.push(await submit(a));
      expect(first.map((r) => r.status)).toEqual(Array(MAX_IMPORTS_IN_FLIGHT).fill(202));
      const over = await submit(a);
      expect(over.status).toBe(429);
      expect(over.body.code).toBe('rate_limited');
      expect((await submit(b)).status).toBe(202); // another business is not blocked by a's backlog

      await quiet.db.withContext({ tenantId: a.tenant.id }, (tx) =>
        tx.importJob.update({
          where: { id: first[0]!.body.id },
          data: { status: 'COMPLETED', csv: null },
        }),
      );
      expect((await submit(a)).status).toBe(202); // a slot freed up
    } finally {
      await quiet.close();
    }
  });

  const insert = (extra: object) =>
    t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.importJob.create({
        data: { tenantId: owner.tenant.id, kind: 'products', createdById: owner.user.id, ...extra },
      }),
    );
  const status = async (id: string) => (await t.http.get(`/v1/imports/${id}`).set(auth())).body;

  it('a redelivered job (reclaim) takes over a RUNNING job at once, while a normal call leaves a fresh one alone', async () => {
    const job = await insert({
      status: 'RUNNING',
      startedAt: new Date(),
      csv: `${HEADER}\nReclaimed,RECL-${stamp},10,,pcs,,,,4,`,
    });
    await processImportJob(t.db, { tenantId: owner.tenant.id, importId: job.id });
    expect((await status(job.id)).status).toBe('RUNNING'); // someone else may genuinely be working on it
    await processImportJob(t.db, { tenantId: owner.tenant.id, importId: job.id }, undefined, {
      reclaim: true,
    });
    const done = await status(job.id);
    expect(done).toMatchObject({ status: 'COMPLETED', created: 1 });
    const row = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    );
    expect(row.csv).toBeNull();
  });

  it('a job whose file has vanished is failed with a clear message instead of being left RUNNING', async () => {
    const job = await insert({ csv: null });
    await processImportJob(t.db, { tenantId: owner.tenant.id, importId: job.id });
    const done = await status(job.id);
    expect(done.status).toBe('FAILED');
    expect(done.errors[0].message).toMatch(/no longer available/);
  });

  it('giving up on a job fails it and deletes the stored CSV, but never touches a finished job', async () => {
    const stuck = await insert({
      status: 'RUNNING',
      startedAt: new Date(),
      csv: `${HEADER}\nStuck,STUCK-${stamp},10,,pcs,,,,,`,
    });
    await failImportJob(
      t.db,
      { tenantId: owner.tenant.id, importId: stuck.id },
      'The import could not be completed.',
    );
    expect(await status(stuck.id)).toMatchObject({ status: 'FAILED' });
    const row = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.importJob.findUniqueOrThrow({ where: { id: stuck.id } }),
    );
    expect(row.csv).toBeNull();

    const finished = await insert({ csv: `${HEADER}\nDone,DONE-${stamp},10,,pcs,,,,,` });
    await processImportJob(t.db, { tenantId: owner.tenant.id, importId: finished.id });
    await failImportJob(t.db, { tenantId: owner.tenant.id, importId: finished.id }, 'late failure');
    expect((await status(finished.id)).status).toBe('COMPLETED'); // not overwritten
  });
});
