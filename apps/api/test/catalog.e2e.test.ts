import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  createProduct,
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

describe('products and variants', () => {
  it('creates a product with variants, normalises SKUs, and stores money as integer paisa', async () => {
    const owner = await registerTenant(t);
    const res = await t.http
      .post('/v1/products')
      .set(bearer(owner.accessToken))
      .send({
        name: 'Cotton T-Shirt',
        description: 'Soft cotton',
        unit: 'pcs',
        variants: [
          {
            sku: ' tee-red-m ',
            name: 'Red / M',
            attributes: { colour: 'Red', size: 'M' },
            priceMinor: 125_050,
            costMinor: 80_000,
            reorderPoint: 5,
          },
          { sku: 'tee-red-l', name: 'Red / L', priceMinor: 125_050 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Cotton T-Shirt',
      unit: 'pcs',
      status: 'ACTIVE',
      categoryId: null,
    });
    expect(res.body.variants.map((v: { sku: string }) => v.sku)).toEqual([
      'TEE-RED-M',
      'TEE-RED-L',
    ]);
    expect(res.body.variants[0]).toMatchObject({
      priceMinor: 125_050,
      costMinor: 80_000,
      reorderPoint: 5,
      attributes: { colour: 'Red', size: 'M' },
      archived: false,
      stock: { onHand: 0, reserved: 0, available: 0 },
    });

    const fetched = await t.http.get(`/v1/products/${res.body.id}`).set(bearer(owner.accessToken));
    expect(fetched.body).toEqual(res.body);
  });

  it('rejects non-integer, negative and absurd prices, bad SKUs, and empty variant lists', async () => {
    const owner = await registerTenant(t);
    const post = (variant: object, extra: object = {}) =>
      t.http
        .post('/v1/products')
        .set(bearer(owner.accessToken))
        .send({ name: 'X', variants: [variant], ...extra });
    expect((await post({ sku: 'A1', priceMinor: 12.5 })).status).toBe(400); // floats never become money
    expect((await post({ sku: 'A2', priceMinor: -1 })).status).toBe(400);
    expect((await post({ sku: 'A3', priceMinor: 3_000_000_000 })).status).toBe(400);
    expect((await post({ sku: 'bad sku!', priceMinor: 100 })).status).toBe(400);
    expect((await post({ sku: 'A4', priceMinor: 100 }, { unit: 'furlong' })).status).toBe(400);
    const none = await t.http
      .post('/v1/products')
      .set(bearer(owner.accessToken))
      .send({ name: 'X', variants: [] });
    expect(none.status).toBe(400);
    expect(none.body.errors[0].path).toBe('body.variants');
  });

  it('SKUs are unique per tenant, case-insensitively, including within one request', async () => {
    const owner = await registerTenant(t);
    await createProduct(t, owner.accessToken, { sku: 'DUP-1' });
    const again = await t.http
      .post('/v1/products')
      .set(bearer(owner.accessToken))
      .send({ name: 'Other', variants: [{ sku: 'dup-1', priceMinor: 100 }] });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('conflict');
    const within = await t.http
      .post('/v1/products')
      .set(bearer(owner.accessToken))
      .send({
        name: 'Twice',
        variants: [
          { sku: 'SAME', priceMinor: 1 },
          { sku: 'same', priceMinor: 1 },
        ],
      });
    expect(within.status).toBe(400);
    // The failed attempt left nothing behind (it ran in one transaction).
    const list = await t.http.get('/v1/products?q=twice').set(bearer(owner.accessToken));
    expect(list.body.items).toHaveLength(0);
  });

  it('two tenants may use the same SKU', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    await createProduct(t, a.accessToken, { sku: 'SHARED' });
    await createProduct(t, b.accessToken, { sku: 'SHARED' });
  });

  it('searches by name and SKU, filters by status, and paginates newest first', async () => {
    const owner = await registerTenant(t);
    const names = ['Alpha Mug', 'Beta Mug', 'Gamma Plate', 'Delta Plate', 'Epsilon Bowl'];
    for (const [i, name] of names.entries())
      await createProduct(t, owner.accessToken, { name, sku: `S-${i}` });

    const mugs = await t.http.get('/v1/products?q=mug').set(bearer(owner.accessToken));
    expect(mugs.body.items.map((p: { name: string }) => p.name).sort()).toEqual([
      'Alpha Mug',
      'Beta Mug',
    ]);
    const bySku = await t.http.get('/v1/products?q=s-3').set(bearer(owner.accessToken));
    expect(bySku.body.items.map((p: { name: string }) => p.name)).toEqual(['Delta Plate']);

    const p1 = (await t.http.get('/v1/products?limit=2').set(bearer(owner.accessToken))).body;
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (
      await t.http
        .get(`/v1/products?limit=2&cursor=${p1.nextCursor}`)
        .set(bearer(owner.accessToken))
    ).body;
    const p3 = (
      await t.http
        .get(`/v1/products?limit=2&cursor=${p2.nextCursor}`)
        .set(bearer(owner.accessToken))
    ).body;
    const all = [...p1.items, ...p2.items, ...p3.items].map((p: { name: string }) => p.name);
    expect(all).toHaveLength(5);
    expect(new Set(all).size).toBe(5);
    expect(all[0]).toBe('Epsilon Bowl'); // newest first
    expect(p3.nextCursor).toBeNull();

    await t.http
      .patch(`/v1/products/${p1.items[0].id}`)
      .set(bearer(owner.accessToken))
      .send({ status: 'ARCHIVED' })
      .expect(200);
    const active = (await t.http.get('/v1/products?status=ACTIVE').set(bearer(owner.accessToken)))
      .body.items;
    const archived = (
      await t.http.get('/v1/products?status=ARCHIVED').set(bearer(owner.accessToken))
    ).body.items;
    expect(active).toHaveLength(4);
    expect(archived).toHaveLength(1);
  });

  it('edits a product and its variants; the SKU is immutable', async () => {
    const owner = await registerTenant(t);
    const { product, variant } = await createProduct(t, owner.accessToken, {
      sku: 'EDIT-1',
      priceMinor: 1000,
    });
    const updated = await t.http
      .patch(`/v1/products/${product.id}`)
      .set(bearer(owner.accessToken))
      .send({ name: 'Renamed', description: 'New text', unit: 'kg' });
    expect(updated.body).toMatchObject({ name: 'Renamed', description: 'New text', unit: 'kg' });

    const v = await t.http
      .patch(`/v1/variants/${variant.id}`)
      .set(bearer(owner.accessToken))
      .send({ priceMinor: 1500, costMinor: 900, sku: 'HACKED', barcode: '8901234567890' });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({
      sku: 'EDIT-1',
      priceMinor: 1500,
      costMinor: 900,
      barcode: '8901234567890',
    }); // sku in the body is ignored
    const log = (
      await t.http.get('/v1/audit-logs?limit=100').set(bearer(owner.accessToken)).expect(200)
    ).body.items as { action: string; targetId: string; metadata: Record<string, unknown> }[];
    expect(
      log.find((e) => e.targetId === variant.id && e.action === 'variant.updated'),
    ).toMatchObject({
      metadata: { price: { before: 1000, after: 1500 }, cost: { before: null, after: 900 } },
    });

    const added = await t.http
      .post(`/v1/products/${product.id}/variants`)
      .set(bearer(owner.accessToken))
      .send({ sku: 'EDIT-2', priceMinor: 2000 });
    expect(added.status).toBe(201);
    const clash = await t.http
      .post(`/v1/products/${product.id}/variants`)
      .set(bearer(owner.accessToken))
      .send({ sku: 'edit-2', priceMinor: 1 });
    expect(clash.status).toBe(409);
    expect(
      (await t.http.get(`/v1/products/${product.id}`).set(bearer(owner.accessToken))).body.variants,
    ).toHaveLength(2);
  });

  it('returns 404 for an unknown product and 400 for a malformed id', async () => {
    const owner = await registerTenant(t);
    expect(
      (
        await t.http
          .get('/v1/products/0197b0a0-0000-7000-8000-00000000dead')
          .set(bearer(owner.accessToken))
      ).status,
    ).toBe(404);
    expect(
      (await t.http.get('/v1/products/not-a-uuid').set(bearer(owner.accessToken))).status,
    ).toBe(400);
  });
});

describe('categories', () => {
  it('creates, renames, lists and deletes; names are unique case-insensitively', async () => {
    const owner = await registerTenant(t);
    const token = owner.accessToken;
    const shirts = (await t.http.post('/v1/categories').set(bearer(token)).send({ name: 'Shirts' }))
      .body;
    expect(
      (await t.http.post('/v1/categories').set(bearer(token)).send({ name: 'shirts' })).status,
    ).toBe(409);
    await t.http.post('/v1/categories').set(bearer(token)).send({ name: 'Bags' }).expect(201);
    expect(
      (await t.http.get('/v1/categories').set(bearer(token))).body.map(
        (c: { name: string }) => c.name,
      ),
    ).toEqual(['Bags', 'Shirts']);
    expect(
      (await t.http.patch(`/v1/categories/${shirts.id}`).set(bearer(token)).send({ name: 'Tops' }))
        .body.name,
    ).toBe('Tops');
    expect(
      (await t.http.patch(`/v1/categories/${shirts.id}`).set(bearer(token)).send({ name: 'bags' }))
        .status,
    ).toBe(409);
  });

  it('deleting a category keeps its products, now uncategorised', async () => {
    const owner = await registerTenant(t);
    const cat = (
      await t.http.post('/v1/categories').set(bearer(owner.accessToken)).send({ name: 'Temp' })
    ).body;
    const { product } = await createProduct(t, owner.accessToken, { categoryId: cat.id });
    expect(product).toBeDefined();
    await t.http.delete(`/v1/categories/${cat.id}`).set(bearer(owner.accessToken)).expect(200);
    expect(
      (await t.http.get(`/v1/products/${product.id}`).set(bearer(owner.accessToken))).body
        .categoryId,
    ).toBeNull();
  });

  it("a product cannot be put in another tenant's category", async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    const aCat = (
      await t.http.post('/v1/categories').set(bearer(a.accessToken)).send({ name: 'Private' })
    ).body;
    const res = await t.http
      .post('/v1/products')
      .set(bearer(b.accessToken))
      .send({ name: 'X', categoryId: aCat.id, variants: [{ sku: 'X-1', priceMinor: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe('body.categoryId');
  });
});

describe('stock locations', () => {
  it('a default location appears the first time stock is used (listing never creates one); another can take over as default', async () => {
    const owner = await registerTenant(t);
    // Reading is read-only: a brand-new business has no locations until something needs one.
    expect((await t.http.get('/v1/locations').set(bearer(owner.accessToken))).body).toEqual([]);
    const { variant } = await createProduct(t, owner.accessToken);
    await t.http
      .post('/v1/inventory/receive')
      .set(bearer(owner.accessToken))
      .send({ variantId: variant.id, quantity: 1 })
      .expect(201);
    const first = (await t.http.get('/v1/locations').set(bearer(owner.accessToken))).body;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: 'Main warehouse', isDefault: true, archived: false });
    const shop = (
      await t.http
        .post('/v1/locations')
        .set(bearer(owner.accessToken))
        .send({ name: 'Dhanmondi shop' })
    ).body;
    expect(shop.isDefault).toBe(false);
    expect(
      (
        await t.http
          .post('/v1/locations')
          .set(bearer(owner.accessToken))
          .send({ name: 'DHANMONDI SHOP' })
      ).status,
    ).toBe(409);

    await t.http
      .patch(`/v1/locations/${shop.id}`)
      .set(bearer(owner.accessToken))
      .send({ isDefault: true })
      .expect(200);
    const after = (await t.http.get('/v1/locations').set(bearer(owner.accessToken))).body;
    expect(after.filter((l: { isDefault: boolean }) => l.isDefault)).toHaveLength(1);
    expect(after[0].id).toBe(shop.id);
  });

  it('the default location cannot be archived, and a location holding stock cannot either', async () => {
    const owner = await registerTenant(t);
    const seed = await createProduct(t, owner.accessToken);
    await t.http
      .post('/v1/inventory/receive')
      .set(bearer(owner.accessToken))
      .send({ variantId: seed.variant.id, quantity: 1 })
      .expect(201); // creates the default
    const main = (await t.http.get('/v1/locations').set(bearer(owner.accessToken))).body[0];
    expect(
      (
        await t.http
          .patch(`/v1/locations/${main.id}`)
          .set(bearer(owner.accessToken))
          .send({ archived: true })
      ).status,
    ).toBe(409);

    const extra = (
      await t.http.post('/v1/locations').set(bearer(owner.accessToken)).send({ name: 'Annex' })
    ).body;
    const { variant } = await createProduct(t, owner.accessToken);
    await t.http
      .post('/v1/inventory/receive')
      .set(bearer(owner.accessToken))
      .send({ variantId: variant.id, locationId: extra.id, quantity: 3 })
      .expect(201);
    expect(
      (
        await t.http
          .patch(`/v1/locations/${extra.id}`)
          .set(bearer(owner.accessToken))
          .send({ archived: true })
      ).status,
    ).toBe(409);
    await t.http
      .post('/v1/inventory/adjust')
      .set(bearer(owner.accessToken))
      .send({ variantId: variant.id, locationId: extra.id, delta: -3, reason: 'moved out' })
      .expect(201);
    expect(
      (
        await t.http
          .patch(`/v1/locations/${extra.id}`)
          .set(bearer(owner.accessToken))
          .send({ archived: true })
      ).status,
    ).toBe(200);
  });
});

describe('who may do what', () => {
  it('enforces the catalog and inventory permission matrix', async () => {
    const owner = await registerTenant(t);
    const staff = await addMember(t, owner, 'STAFF');
    const accountant = await addMember(t, owner, 'ACCOUNTANT');
    const manager = await addMember(t, owner, 'MANAGER');
    const { variant } = await createProduct(t, owner.accessToken);
    const newProduct = (n: number) => ({
      name: `P${n}`,
      variants: [{ sku: `RBAC-${n}-${Date.now()}`, priceMinor: 100 }],
    });
    const receive = { variantId: variant.id, quantity: 1 };

    const status = async (
      who: { accessToken: string },
      method: 'get' | 'post',
      path: string,
      body?: object,
    ) => (await t.http[method](path).set(bearer(who.accessToken)).send(body)).status;

    // everyone can read the catalog and stock
    for (const who of [owner, manager, staff, accountant]) {
      expect(await status(who, 'get', '/v1/products')).toBe(200);
      expect(await status(who, 'get', '/v1/inventory')).toBe(200);
      expect(await status(who, 'get', '/v1/inventory/low-stock')).toBe(200);
    }
    // owner and manager change the catalog; staff and accountant cannot
    expect(await status(manager, 'post', '/v1/products', newProduct(1))).toBe(201);
    expect(await status(staff, 'post', '/v1/products', newProduct(2))).toBe(403);
    expect(await status(accountant, 'post', '/v1/products', newProduct(3))).toBe(403);
    expect(await status(staff, 'post', '/v1/categories', { name: 'Nope' })).toBe(403);
    expect(await status(staff, 'post', '/v1/locations', { name: 'Nope' })).toBe(403);
    expect(
      await status(staff, 'post', '/v1/imports/products', { csv: 'product_name,sku,price\nA,B,1' }),
    ).toBe(403);
    // staff can move stock; the accountant cannot
    expect(await status(staff, 'post', '/v1/inventory/receive', receive)).toBe(201);
    expect(await status(accountant, 'post', '/v1/inventory/receive', receive)).toBe(403);
    expect(await status(accountant, 'post', '/v1/reservations', receive)).toBe(403);
    // and nobody without a token
    expect((await t.http.get('/v1/products')).status).toBe(401);
    expect((await t.http.post('/v1/inventory/receive').send(receive)).status).toBe(401);
  });

  it("tenants cannot see or change each other's catalog", async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    const { product, variant } = await createProduct(t, a.accessToken, {
      name: 'Secret Recipe Mug',
      sku: 'ISO-1',
    });
    await t.http
      .post('/v1/inventory/receive')
      .set(bearer(a.accessToken))
      .send({ variantId: variant.id, quantity: 5 })
      .expect(201);

    expect((await t.http.get(`/v1/products/${product.id}`).set(bearer(b.accessToken))).status).toBe(
      404,
    );
    expect(
      (
        await t.http
          .patch(`/v1/products/${product.id}`)
          .set(bearer(b.accessToken))
          .send({ name: 'pwned' })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.http
          .patch(`/v1/variants/${variant.id}`)
          .set(bearer(b.accessToken))
          .send({ priceMinor: 1 })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.http
          .post(`/v1/products/${product.id}/variants`)
          .set(bearer(b.accessToken))
          .send({ sku: 'X', priceMinor: 1 })
      ).status,
    ).toBe(404);
    expect(
      (await t.http.get('/v1/products?q=secret').set(bearer(b.accessToken))).body.items,
    ).toHaveLength(0);
    expect((await t.http.get('/v1/inventory').set(bearer(b.accessToken))).body.items).toHaveLength(
      0,
    );
    const cross = await t.http
      .post('/v1/inventory/receive')
      .set(bearer(b.accessToken))
      .send({ variantId: variant.id, quantity: 100 });
    expect(cross.status).toBe(404); // the variant does not exist for tenant B
    // tenant A is untouched
    const stock = (await t.http.get('/v1/inventory').set(bearer(a.accessToken))).body.items;
    expect(stock).toHaveLength(1);
    expect(stock[0]).toMatchObject({ onHand: 5, sku: 'ISO-1' });
    expect(uniqueEmail()).toBeTruthy();
  });
});
