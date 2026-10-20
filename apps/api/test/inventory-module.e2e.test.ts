import { IMPORT_COLUMNS, parseCsv } from '@orderloop/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  createProduct,
  createTestApp,
  registerTenant,
  type TestApp,
} from './app.js';

let t: TestApp;
let owner: Awaited<ReturnType<typeof registerTenant>>;
beforeAll(async () => {
  t = await createTestApp();
  owner = await registerTenant(t);
});
afterAll(() => t.close());

const auth = (who: { accessToken: string } = owner) => bearer(who.accessToken);
const post = (path: string, body: object, who: { accessToken: string } = owner) =>
  t.http.post(path).set(auth(who)).send(body);
const patch = (path: string, body: object, who: { accessToken: string } = owner) =>
  t.http.patch(path).set(auth(who)).send(body);
const get = (path: string, who: { accessToken: string } = owner) => t.http.get(path).set(auth(who));
let seq = 0;
const key = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`;
const level = async (variantId: string, who: { accessToken: string } = owner) => {
  const items = (await get(`/v1/inventory?variantId=${variantId}`, who)).body.items as {
    onHand: number;
    reserved: number;
    available: number;
    damaged: number;
  }[];
  return items[0] ?? { onHand: 0, reserved: 0, available: 0, damaged: 0 };
};
const stocked = async (qty: number, extra: Parameters<typeof createProduct>[2] = {}) => {
  const { variant, product } = await createProduct(t, owner.accessToken, extra);
  if (qty > 0)
    await post('/v1/inventory/receive', { variantId: variant.id, quantity: qty }).expect(201);
  return { variantId: variant.id, productId: product.id, sku: variant.sku };
};

describe('products: description, pictures, prices, threshold, variants', () => {
  it('stores and returns everything the product form edits, with money in whole paisa', async () => {
    const res = await post('/v1/products', {
      name: 'Cotton panjabi',
      description: 'Handloom cotton, Eid collection',
      unit: 'pcs',
      imageUrls: ['https://cdn.example.test/p1.jpg', 'https://cdn.example.test/p2.jpg'],
      variants: [
        {
          sku: 'pan-red-m',
          name: 'Red / M',
          attributes: { colour: 'Red', size: 'M' },
          priceMinor: 125050, // ৳1,250.50
          costMinor: 80025,
          reorderPoint: 5,
        },
        { sku: 'pan-red-l', attributes: { colour: 'Red', size: 'L' }, priceMinor: 130000 },
      ],
    }).expect(201);
    expect(res.body).toMatchObject({
      description: 'Handloom cotton, Eid collection',
      imageUrls: ['https://cdn.example.test/p1.jpg', 'https://cdn.example.test/p2.jpg'],
    });
    expect(res.body.variants[0]).toMatchObject({
      sku: 'PAN-RED-M',
      attributes: { colour: 'Red', size: 'M' },
      priceMinor: 125050,
      costMinor: 80025,
      reorderPoint: 5,
      stock: { onHand: 0, reserved: 0, available: 0, damaged: 0 },
    });
  });

  it('refuses fractional money, insecure or too many picture links', async () => {
    const base = { name: 'Bad one', variants: [{ sku: 'bad-1', priceMinor: 100 }] };
    expect(
      (await post('/v1/products', { ...base, variants: [{ sku: 'bad-1', priceMinor: 12.5 }] }))
        .status,
    ).toBe(400);
    expect(
      (await post('/v1/products', { ...base, imageUrls: ['http://insecure.test/a.jpg'] })).status,
    ).toBe(400);
    expect(
      (
        await post('/v1/products', {
          ...base,
          imageUrls: Array.from({ length: 9 }, (_, i) => `https://cdn.example.test/${i}.jpg`),
        })
      ).status,
    ).toBe(400);
  });

  it('edits, archives, restores and searches by name or SKU', async () => {
    const { productId, sku } = await stocked(0, { name: 'Searchable Lungi', sku: 'LUNGI-77' });
    await patch(`/v1/products/${productId}`, {
      description: 'New text',
      imageUrls: ['https://cdn.example.test/x.jpg'],
    }).expect(200);
    expect((await get(`/v1/products/${productId}`)).body.imageUrls).toEqual([
      'https://cdn.example.test/x.jpg',
    ]);
    const byName = (await get('/v1/products?q=lungi')).body.items as { id: string }[];
    expect(byName.map((p) => p.id)).toContain(productId);
    const bySku = (await get(`/v1/products?q=${sku.toLowerCase()}`)).body.items as { id: string }[];
    expect(bySku.map((p) => p.id)).toContain(productId);

    await patch(`/v1/products/${productId}`, { status: 'ARCHIVED' }).expect(200);
    const active = (await get('/v1/products?status=ACTIVE&q=lungi')).body.items as { id: string }[];
    expect(active.map((p) => p.id)).not.toContain(productId);
    await patch(`/v1/products/${productId}`, { status: 'ACTIVE' }).expect(200);
  });
});

describe('suppliers', () => {
  it('creates, edits, archives; names are unique per business; details are validated', async () => {
    const created = (
      await post('/v1/suppliers', {
        name: 'Rahim Textiles',
        contactName: 'Rahim',
        phone: '+880 1711-000000',
        email: 'RAHIM@textiles.test',
        address: 'Narayanganj',
      }).expect(201)
    ).body;
    expect(created).toMatchObject({
      name: 'Rahim Textiles',
      email: 'rahim@textiles.test',
      archived: false,
    });
    expect((await post('/v1/suppliers', { name: 'rahim textiles' })).status).toBe(409);
    expect((await post('/v1/suppliers', { name: 'Bad Phone', phone: 'call me' })).status).toBe(400);
    expect((await post('/v1/suppliers', { name: 'Bad Mail', email: 'nope' })).status).toBe(400);

    const edited = (await patch(`/v1/suppliers/${created.id}`, { notes: 'Net 30' }).expect(200))
      .body;
    expect(edited.notes).toBe('Net 30');
    await patch(`/v1/suppliers/${created.id}`, { archived: true }).expect(200);
    const list = (await get('/v1/suppliers')).body as { id: string; archived: boolean }[];
    expect(list.find((s) => s.id === created.id)?.archived).toBe(true);
  });

  it('links to a product; an archived or missing supplier cannot be chosen', async () => {
    const s = (await post('/v1/suppliers', { name: `Linked ${key('s')}` }).expect(201)).body;
    const p = (
      await post('/v1/products', {
        name: 'Supplied item',
        supplierId: s.id,
        variants: [{ sku: key('SUP').toUpperCase(), priceMinor: 100 }],
      }).expect(201)
    ).body;
    expect(p.supplierId).toBe(s.id);
    await patch(`/v1/suppliers/${s.id}`, { archived: true }).expect(200);
    const res = await patch(`/v1/products/${p.id}`, { supplierId: s.id });
    expect(res.status).toBe(400);
    expect(
      (await patch(`/v1/products/${p.id}`, { supplierId: null }).expect(200)).body.supplierId,
    ).toBeNull();
  });

  it('is private to the business and honours roles', async () => {
    const other = await registerTenant(t);
    const mine = (await post('/v1/suppliers', { name: `Private ${key('s')}` }).expect(201)).body;
    // another business: cannot see, change or link it
    expect(JSON.stringify((await get('/v1/suppliers', other)).body)).not.toContain(mine.id);
    expect((await patch(`/v1/suppliers/${mine.id}`, { name: 'Stolen name' }, other)).status).toBe(
      404,
    );
    const theirs = await post(
      '/v1/products',
      {
        name: 'Cross link',
        supplierId: mine.id,
        variants: [{ sku: key('X').toUpperCase(), priceMinor: 1 }],
      },
      other,
    );
    expect(theirs.status).toBe(400);
    expect(
      (await get('/v1/suppliers')).body.find((s: { id: string }) => s.id === mine.id).name,
    ).toBe(mine.name);
    // roles: staff and accountant read, only owner/admin/manager write
    const staff = await addMember(t, owner, 'STAFF');
    const accountant = await addMember(t, owner, 'ACCOUNTANT');
    expect((await get('/v1/suppliers', staff)).status).toBe(200);
    expect((await get('/v1/suppliers', accountant)).status).toBe(200);
    expect((await post('/v1/suppliers', { name: 'Nope staff' }, staff)).status).toBe(403);
    expect((await post('/v1/suppliers', { name: 'Nope acct' }, accountant)).status).toBe(403);
  });
});

describe('damaged stock', () => {
  it('moves units out of what can be sold, with the reason in the ledger', async () => {
    const { variantId } = await stocked(10);
    const res = await post('/v1/inventory/damage', {
      variantId,
      quantity: 3,
      reason: 'water damage in the monsoon',
    }).expect(201);
    expect(res.body).toMatchObject({ onHand: 7, damaged: 3, available: 7 });
    expect(await level(variantId)).toMatchObject({ onHand: 7, reserved: 0, damaged: 3 });
    const movements = (await get(`/v1/inventory/movements?variantId=${variantId}&type=DAMAGE`)).body
      .items as { onHandDelta: number; damagedDelta: number; reason: string }[];
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      onHandDelta: -3,
      damagedDelta: 3,
      reason: 'water damage in the monsoon',
    });
  });

  it('cannot damage reserved units, and needs a reason', async () => {
    const { variantId } = await stocked(10);
    await post('/v1/reservations', { variantId, quantity: 8 }).expect(201);
    const tooMany = await post('/v1/inventory/damage', {
      variantId,
      quantity: 3,
      reason: 'cracked',
    });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.code).toBe('insufficient_stock');
    expect((await post('/v1/inventory/damage', { variantId, quantity: 1 })).status).toBe(400);
    await post('/v1/inventory/damage', { variantId, quantity: 2, reason: 'cracked' }).expect(201);
    expect(await level(variantId)).toMatchObject({
      onHand: 8,
      reserved: 8,
      available: 0,
      damaged: 2,
    });
  });

  it('writes damaged units off, never more than are damaged', async () => {
    const { variantId } = await stocked(5);
    await post('/v1/inventory/damage', { variantId, quantity: 4, reason: 'fire' }).expect(201);
    const over = await post('/v1/inventory/write-off', {
      variantId,
      quantity: 5,
      reason: 'disposed',
    });
    expect(over.status).toBe(409);
    await post('/v1/inventory/write-off', { variantId, quantity: 4, reason: 'disposed' }).expect(
      201,
    );
    expect(await level(variantId)).toMatchObject({ onHand: 1, damaged: 0 });
  });

  it('a repeated request with the same key changes nothing', async () => {
    const { variantId } = await stocked(10);
    const idempotencyKey = key('damage');
    const body = { variantId, quantity: 2, reason: 'torn', idempotencyKey };
    const first = await post('/v1/inventory/damage', body).expect(201);
    const second = await post('/v1/inventory/damage', body);
    expect(second.status).toBe(201);
    expect(second.body.movementId).toBe(first.body.movementId);
    expect(await level(variantId)).toMatchObject({ onHand: 8, damaged: 2 });
    expect((await post('/v1/inventory/damage', { ...body, quantity: 3 })).status).toBe(409); // same key, different request
  });

  it('is excluded from available stock and from low-stock maths', async () => {
    const { variantId } = await stocked(10, { reorderPoint: 4 });
    expect(
      ((await get('/v1/inventory/low-stock')).body as { variantId: string }[]).map(
        (v) => v.variantId,
      ),
    ).not.toContain(variantId);
    await post('/v1/inventory/damage', { variantId, quantity: 7, reason: 'flood' }).expect(201);
    const low = (await get('/v1/inventory/low-stock')).body as {
      variantId: string;
      available: number;
      damaged: number;
    }[];
    expect(low.find((v) => v.variantId === variantId)).toMatchObject({ available: 3, damaged: 7 });
    const lowFlag = (await get('/v1/inventory?lowStock=true')).body.items as {
      variantId: string;
    }[];
    expect(lowFlag.map((l) => l.variantId)).toContain(variantId);
  });

  it('simultaneous damage and reservations can never leave promised units uncovered', async () => {
    const { variantId } = await stocked(10);
    const results = await Promise.all([
      ...Array.from({ length: 12 }, () =>
        post('/v1/inventory/damage', { variantId, quantity: 1, reason: 'race test' }),
      ),
      ...Array.from({ length: 12 }, () => post('/v1/reservations', { variantId, quantity: 1 })),
    ]);
    for (const r of results) expect([201, 409]).toContain(r.status);
    const lv = await level(variantId);
    expect(lv.onHand + lv.damaged).toBe(10); // nothing created or lost
    expect(lv.reserved).toBeLessThanOrEqual(lv.onHand);
    expect(lv.available).toBeGreaterThanOrEqual(0);
  });
});

describe('returns and cancellations update stock exactly once', () => {
  it('a return needs an idempotency key', async () => {
    const { variantId } = await stocked(1);
    const res = await post('/v1/inventory/return', {
      variantId,
      quantity: 1,
      condition: 'RESALEABLE',
    });
    expect(res.status).toBe(400);
  });

  it('processing the same return twice adds the units once', async () => {
    const { variantId } = await stocked(5);
    const body = {
      variantId,
      quantity: 2,
      condition: 'RESALEABLE',
      idempotencyKey: `return:${key('r')}:${variantId}`,
      referenceType: 'return',
      referenceId: 'RET-1001',
    };
    const first = await post('/v1/inventory/return', body).expect(201);
    const again = await Promise.all(
      Array.from({ length: 5 }, () => post('/v1/inventory/return', body)),
    );
    for (const r of again) {
      expect(r.status).toBe(201);
      expect(r.body.movementId).toBe(first.body.movementId);
    }
    expect(await level(variantId)).toMatchObject({ onHand: 7, damaged: 0 });
    const rows = (await get(`/v1/inventory/movements?variantId=${variantId}&type=RETURN`)).body
      .items as { referenceType: string; referenceId: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ referenceType: 'return', referenceId: 'RET-1001' });
    // the same key for a different return is a client bug and is refused, not applied
    expect((await post('/v1/inventory/return', { ...body, quantity: 9 })).status).toBe(409);
  });

  it('a damaged return goes to the damaged bucket, not to sale', async () => {
    const { variantId } = await stocked(0);
    const res = await post('/v1/inventory/return', {
      variantId,
      quantity: 3,
      condition: 'DAMAGED',
      idempotencyKey: key('retd'),
    }).expect(201);
    expect(res.body).toMatchObject({ onHand: 0, damaged: 3, available: 0 });
  });

  it('releasing a reservation works once; a second cancel and a late fulfil are refused', async () => {
    const { variantId } = await stocked(10);
    const reservation = (
      await post('/v1/reservations', {
        variantId,
        quantity: 4,
        referenceType: 'manual',
        referenceId: 'ORD-1',
        idempotencyKey: key('res'),
      }).expect(201)
    ).body;
    expect(await level(variantId)).toMatchObject({ onHand: 10, reserved: 4, available: 6 });
    await post(`/v1/reservations/${reservation.id}/release`, {}).expect(200);
    const again = await post(`/v1/reservations/${reservation.id}/release`, {});
    expect(again.status).toBe(409);
    expect((await post(`/v1/reservations/${reservation.id}/fulfil`, {})).status).toBe(409);
    expect(await level(variantId)).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
    const releases = (await get(`/v1/inventory/movements?variantId=${variantId}&type=RELEASE`)).body
      .items as unknown[];
    expect(releases).toHaveLength(1);
  });

  it('a product with an active reservation cannot be archived until it is released', async () => {
    const { variantId, productId } = await stocked(10);
    const reservation = (await post('/v1/reservations', { variantId, quantity: 2 }).expect(201))
      .body;
    const refused = await patch(`/v1/products/${productId}`, { status: 'ARCHIVED' });
    expect(refused.status).toBe(409);
    expect((await get(`/v1/products/${productId}`)).body.status).toBe('ACTIVE');
    await post(`/v1/reservations/${reservation.id}/release`, {}).expect(200);
    await patch(`/v1/products/${productId}`, { status: 'ARCHIVED' }).expect(200);
  });

  it('reserving with the same key twice holds the stock once', async () => {
    const { variantId } = await stocked(10);
    const body = {
      variantId,
      quantity: 3,
      idempotencyKey: key('order'),
      referenceType: 'manual',
      referenceId: 'ORD-2',
    };
    const a = await post('/v1/reservations', body).expect(201);
    const b = await post('/v1/reservations', body);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await level(variantId)).toMatchObject({ reserved: 3 });
  });
});

describe('CSV export', () => {
  it('writes the catalog in the import columns, with decimal prices, and imports back cleanly', async () => {
    const exporter = await registerTenant(t);
    await post(
      '/v1/products',
      {
        name: 'Export tee',
        description: 'Soft, "premium" cotton, 180gsm',
        variants: [
          {
            sku: 'EXP-1',
            name: 'Blue / S',
            attributes: { colour: 'Blue', size: 'S' },
            priceMinor: 125050,
            costMinor: 70000,
            reorderPoint: 3,
          },
        ],
      },
      exporter,
    ).expect(201);
    const res = await get('/v1/exports/products', exporter).expect(200);
    expect(res.body.filename).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(res.body.rowCount).toBe(1);
    const [header, row] = parseCsv(res.body.csv as string);
    expect(header).toEqual([...IMPORT_COLUMNS]);
    const record = Object.fromEntries(header!.map((h, i) => [h, row![i]]));
    expect(record).toMatchObject({
      product_name: 'Export tee',
      sku: 'EXP-1',
      price: '1250.50',
      cost: '700.00',
      size: 'S',
      colour: 'Blue',
      reorder_point: '3',
      description: 'Soft, "premium" cotton, 180gsm',
    });
    // the exported file passes the importer's own check
    const preview = await post(
      '/v1/imports/products/validate',
      { csv: res.body.csv },
      exporter,
    ).expect(200);
    expect(preview.body).toMatchObject({
      fatal: null,
      errorCount: 0,
      willUpdate: 1,
      willCreate: 0,
    });
  });

  it('neutralises spreadsheet formulas and leaves out archived items', async () => {
    const exporter = await registerTenant(t);
    const evil = (
      await post(
        '/v1/products',
        {
          name: '=HYPERLINK("http://evil.test","click")',
          variants: [{ sku: 'EVIL-1', priceMinor: 100 }],
        },
        exporter,
      ).expect(201)
    ).body;
    const gone = (
      await post(
        '/v1/products',
        { name: 'Archived thing', variants: [{ sku: 'GONE-1', priceMinor: 100 }] },
        exporter,
      ).expect(201)
    ).body;
    await patch(`/v1/products/${gone.id}`, { status: 'ARCHIVED' }, exporter).expect(200);
    const csv = (await get('/v1/exports/products', exporter).expect(200)).body.csv as string;
    expect(csv).toContain(`'=HYPERLINK`);
    expect(csv).not.toMatch(/(^|,|\n)=HYPERLINK/);
    expect(csv).not.toContain('GONE-1');
    expect(evil.id).toBeTruthy();
  });

  it('exports stock per variant and location, including damaged', async () => {
    const exporter = await registerTenant(t);
    const p = (
      await post(
        '/v1/products',
        { name: 'Stock csv', variants: [{ sku: 'STK-1', priceMinor: 100 }] },
        exporter,
      ).expect(201)
    ).body;
    const variantId = p.variants[0].id;
    await post('/v1/inventory/receive', { variantId, quantity: 10 }, exporter).expect(201);
    await post(
      '/v1/inventory/damage',
      { variantId, quantity: 2, reason: 'crushed' },
      exporter,
    ).expect(201);
    await post('/v1/reservations', { variantId, quantity: 3 }, exporter).expect(201);
    const csv = (await get('/v1/exports/stock', exporter).expect(200)).body.csv as string;
    const [header, row] = parseCsv(csv);
    expect(header).toEqual([
      'sku',
      'product_name',
      'variant_name',
      'location',
      'on_hand',
      'reserved',
      'damaged',
      'available',
      'reorder_point',
    ]);
    expect(row).toEqual(['STK-1', 'Stock csv', '', 'Main warehouse', '8', '3', '2', '5', '0']);
  });

  it('only ever contains the caller’s own business, and follows permissions', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    await post(
      '/v1/products',
      { name: 'Alpha only', variants: [{ sku: 'ALPHA-ONLY', priceMinor: 1 }] },
      a,
    ).expect(201);
    const bCsv = (await get('/v1/exports/products', b).expect(200)).body.csv as string;
    expect(bCsv).not.toContain('ALPHA-ONLY');
    const bStock = (await get('/v1/exports/stock', b).expect(200)).body.csv as string;
    expect(bStock).not.toContain('ALPHA-ONLY');
    const accountant = await addMember(t, a, 'ACCOUNTANT');
    const before = (await get('/v1/audit-logs', a).expect(200)).body.items as { action: string }[];
    expect(before.map((e) => e.action)).not.toContain('export.products'); // nothing exported by A yet
    expect((await get('/v1/exports/products', accountant)).status).toBe(200);
    expect((await get('/v1/exports/stock', accountant)).status).toBe(200);
    const after = (await get('/v1/audit-logs', a).expect(200)).body.items as { action: string }[];
    expect(after.map((e) => e.action)).toEqual(
      expect.arrayContaining(['export.products', 'export.stock']),
    );
  });
});

describe('import preview (nothing is applied)', () => {
  const header = 'product_name,sku,price,category,unit,size,colour,supplier,opening_stock\n';

  it('reports file problems, counts, and changes nothing', async () => {
    const importer = await registerTenant(t);
    const csv =
      header +
      'Shirt,SH-1,500,Tops,pcs,M,Red,Acme,5\n' +
      'Shirt,SH-2,500.5,Tops,pcs,L,Red,Acme,0\n' +
      'Bad price,BP-1,12.345,,pcs,,,,\n' +
      'No sku,,100,,pcs,,,,\n' +
      'Weird unit,WU-1,100,,bunch,,,,\n';
    const res = await post('/v1/imports/products/validate', { csv }, importer).expect(200);
    expect(res.body).toMatchObject({
      fatal: null,
      totalRows: 5,
      validRows: 2,
      willCreate: 2,
      willUpdate: 0,
      errorCount: 3,
    });
    expect((res.body.errors as { row: number }[]).map((e) => e.row)).toEqual([4, 5, 6]);
    expect(res.body.errors[0].message).toMatch(/at most 2 decimals/);
    // nothing was written
    expect((await get('/v1/products', importer)).body.items).toHaveLength(0);
    expect((await get('/v1/suppliers', importer)).body).toHaveLength(0);
    expect((await get('/v1/categories', importer)).body).toHaveLength(0);
  });

  it('refuses a file it cannot read, with the reason', async () => {
    const importer = await registerTenant(t);
    const bad = await post(
      '/v1/imports/products/validate',
      { csv: 'name,price\nx,1\n' },
      importer,
    ).expect(200);
    expect(bad.body.fatal).toMatch(/Unknown column|Missing required/);
    const unterminated = await post(
      '/v1/imports/products/validate',
      { csv: 'product_name,sku,price\n"x,1,2\n' },
      importer,
    ).expect(200);
    expect(unterminated.body.fatal).toBeTruthy();
  });

  it('knows what already exists: updates versus creates, and conflicts with existing data', async () => {
    const importer = await registerTenant(t);
    const existing = (
      await post(
        '/v1/products',
        { name: 'Old shirt', variants: [{ sku: 'OLD-1', priceMinor: 100 }] },
        importer,
      ).expect(201)
    ).body;
    await post(
      '/v1/products',
      { name: 'Other', variants: [{ sku: 'OTH-1', priceMinor: 100 }] },
      importer,
    ).expect(201);
    const archived = (
      await post(
        '/v1/products',
        { name: 'Retired', variants: [{ sku: 'RET-1', priceMinor: 100 }] },
        importer,
      ).expect(201)
    ).body;
    await patch(`/v1/products/${archived.id}`, { status: 'ARCHIVED' }, importer).expect(200);
    const csv =
      'product_name,sku,price,unit\n' +
      'Old shirt,OLD-1,150,pcs\n' + // update
      'Old shirt,OLD-2,150,pcs\n' + // new variant of existing product
      'Retired,RET-2,10,pcs\n' + // product is archived
      'Old shirt,RET-1,10,pcs\n' + // sku belongs to another product
      'Other,OTH-2,10,kg\n'; // product exists with another unit
    const res = await post('/v1/imports/products/validate', { csv }, importer).expect(200);
    expect(res.body).toMatchObject({ willUpdate: 1, willCreate: 1, validRows: 2, errorCount: 3 });
    const messages = (res.body.errors as { message: string }[]).map((e) => e.message).join('\n');
    expect(messages).toMatch(/archived/);
    expect(messages).toMatch(/already belongs to a different product/);
    expect(messages).toMatch(/already exists with unit pcs/);
    expect(existing.id).toBeTruthy();
  });

  it('is part of the catalog-write permission and tenant scoped', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    await post(
      '/v1/products',
      { name: 'Mine', variants: [{ sku: 'MINE-1', priceMinor: 1 }] },
      a,
    ).expect(201);
    // B previews a file using A's SKU: for B it is simply new
    const res = await post(
      '/v1/imports/products/validate',
      { csv: 'product_name,sku,price\nMine,MINE-1,5\n' },
      b,
    ).expect(200);
    expect(res.body).toMatchObject({ willCreate: 1, willUpdate: 0, errorCount: 0 });
    const staff = await addMember(t, a, 'STAFF');
    expect(
      (
        await post(
          '/v1/imports/products/validate',
          { csv: 'product_name,sku,price\nx,Y,1\n' },
          staff,
        )
      ).status,
    ).toBe(403);
  });
});
