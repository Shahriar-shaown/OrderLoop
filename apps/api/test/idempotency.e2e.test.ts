import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createProduct, createTestApp, registerTenant, type TestApp } from './app.js';

/** A retried or double-submitted create must not duplicate: the same `idempotencyKey` returns the first result. */
let t: TestApp;
let a: Awaited<ReturnType<typeof registerTenant>>;
let b: Awaited<ReturnType<typeof registerTenant>>;
const queued: unknown[] = [];

beforeAll(async () => {
  t = await createTestApp({}, { queue: { add: async (...args: unknown[]) => queued.push(args) } });
  a = await registerTenant(t);
  b = await registerTenant(t);
});
afterAll(() => t.close());

let n = 0;
const uniq = () => `${Date.now().toString(36)}${++n}`;
const newKey = () => `test-${randomUUID()}`;
const phone = () => `017${String(Date.now() + ++n).slice(-8)}`;

type Who = typeof a;
const post = (who: Who, path: string, body: object) =>
  t.http.post(path).set(bearer(who.accessToken)).send(body);

/** One creating endpoint: how to call it, how to change its body, and how many rows it has made. */
interface Family {
  name: string;
  /** Anything the body needs to exist first (a product for a variant, a customer for an address). */
  setup?: (who: Who) => Promise<Record<string, string>>;
  path: (ctx: Record<string, string>) => string;
  body: (marker: string, ctx: Record<string, string>) => object;
  /** The same request with something different in it. */
  other: (marker: string, ctx: Record<string, string>) => object;
  count: (who: Who, marker: string, ctx: Record<string, string>) => Promise<number>;
}

const inTenant = <T>(who: Who, fn: Parameters<typeof t.db.withContext<T>>[1]) =>
  t.db.withContext({ tenantId: who.tenant.id, userId: who.user.id }, fn);

const families: Family[] = [
  {
    name: 'products',
    path: () => '/v1/products',
    body: (m) => ({ name: `P ${m}`, variants: [{ sku: `S-${m}`, priceMinor: 1000 }] }),
    other: (m) => ({ name: `P ${m}`, variants: [{ sku: `S-${m}`, priceMinor: 2000 }] }),
    count: (who, m) => inTenant(who, (tx) => tx.product.count({ where: { name: `P ${m}` } })),
  },
  {
    name: 'variants',
    setup: async (who) => ({ productId: (await createProduct(t, who.accessToken)).product.id }),
    path: (c) => `/v1/products/${c.productId}/variants`,
    body: (m) => ({ sku: `V-${m}`, priceMinor: 1000 }),
    other: (m) => ({ sku: `V-${m}`, priceMinor: 3000 }),
    count: (who, m) =>
      inTenant(who, (tx) => tx.productVariant.count({ where: { sku: `V-${m}`.toUpperCase() } })),
  },
  {
    name: 'customers',
    path: () => '/v1/customers',
    body: (m) => ({ name: `Cust ${m}`, phone: m }),
    other: (m) => ({ name: `Someone else ${m}`, phone: m }),
    // (The phone is stored in international form, so count by name.)
    count: (who, m) => inTenant(who, (tx) => tx.customer.count({ where: { name: `Cust ${m}` } })),
  },
  {
    name: 'customer addresses',
    setup: async (who) => ({
      customerId: (
        await post(who, '/v1/customers', { name: 'Rina Akter', phone: phone() }).expect(201)
      ).body.id,
    }),
    path: (c) => `/v1/customers/${c.customerId}/addresses`,
    body: (m) => ({
      recipientName: `R ${m}`,
      phone: '01712345678',
      line1: 'House 1, Road 2',
      area: 'Mirpur',
      district: 'Dhaka',
      division: 'Dhaka',
    }),
    other: (m) => ({
      recipientName: `R ${m}`,
      phone: '01712345678',
      line1: 'House 9, Road 9',
      area: 'Mirpur',
      district: 'Dhaka',
      division: 'Dhaka',
    }),
    count: (who, m) =>
      inTenant(who, (tx) => tx.customerAddress.count({ where: { recipientName: `R ${m}` } })),
  },
  {
    name: 'suppliers',
    path: () => '/v1/suppliers',
    body: (m) => ({ name: `Sup ${m}` }),
    other: (m) => ({ name: `Sup ${m}`, notes: 'changed' }),
    count: (who, m) => inTenant(who, (tx) => tx.supplier.count({ where: { name: `Sup ${m}` } })),
  },
  {
    name: 'locations',
    path: () => '/v1/locations',
    body: (m) => ({ name: `Loc ${m}` }),
    other: (m) => ({ name: `Loc ${m}`, isDefault: true }),
    count: (who, m) =>
      inTenant(who, (tx) => tx.stockLocation.count({ where: { name: `Loc ${m}` } })),
  },
  {
    name: 'categories',
    path: () => '/v1/categories',
    body: (m) => ({ name: `Cat ${m}` }),
    other: (m) => ({ name: `Cat ${m} two` }),
    count: (who, m) => inTenant(who, (tx) => tx.category.count({ where: { name: `Cat ${m}` } })),
  },
  {
    name: 'invitations',
    path: () => '/v1/members/invitations',
    body: (m) => ({ email: `inv-${m}@example.test`, role: 'STAFF' }),
    other: (m) => ({ email: `inv-${m}@example.test`, role: 'MANAGER' }),
    count: (who, m) =>
      inTenant(who, (tx) => tx.invitation.count({ where: { email: `inv-${m}@example.test` } })),
  },
  {
    name: 'product imports',
    // A business may have only a few imports in flight: pretend the earlier ones finished.
    setup: async (who) => {
      await inTenant(who, (tx) => tx.importJob.updateMany({ data: { status: 'COMPLETED' } }));
      return {};
    },
    path: () => '/v1/imports/products',
    body: (m) => ({ csv: `product_name,sku,price\nImp ${m},IMP-${m},10` }),
    other: (m) => ({ csv: `product_name,sku,price\nImp ${m},IMP-${m},99` }),
    count: (who, m) =>
      inTenant(who, (tx) => tx.importJob.count({ where: { csv: { contains: `IMP-${m}` } } })),
  },
];

describe.each(families)('$name', (f) => {
  // Customers are keyed by phone, so their "marker" has to be a phone number; everything else takes any text.
  const marker = () => (f.name === 'customers' ? phone() : uniq());
  const prepare = async (who: Who) => (f.setup ? await f.setup(who) : {});

  it('the same key twice makes one row and returns the same answer', async () => {
    const ctx = await prepare(a);
    const m = marker();
    const key = newKey();
    const first = await post(a, f.path(ctx), { ...f.body(m, ctx), idempotencyKey: key });
    expect(first.status).toBeLessThan(300);
    const second = await post(a, f.path(ctx), { ...f.body(m, ctx), idempotencyKey: key });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await f.count(a, m, ctx)).toBe(1);
  });

  it('the same key with a different request is 409 idempotency_conflict and changes nothing', async () => {
    const ctx = await prepare(a);
    const m = marker();
    const key = newKey();
    const first = await post(a, f.path(ctx), { ...f.body(m, ctx), idempotencyKey: key });
    expect(first.status).toBeLessThan(300);
    const clash = await post(a, f.path(ctx), { ...f.other(m, ctx), idempotencyKey: key });
    expect(clash.status).toBe(409);
    expect(clash.body.code ?? clash.body.type).toMatch(/idempotency_conflict/);
    expect(await f.count(a, m, ctx)).toBe(1);
  });

  it('simultaneous identical requests make one row, and all of them get its answer', async () => {
    const ctx = await prepare(a);
    const m = marker();
    const key = newKey();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        post(a, f.path(ctx), { ...f.body(m, ctx), idempotencyKey: key }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(results[0]!.status));
    expect(results[0]!.status).toBeLessThan(300);
    for (const r of results) expect(r.body).toEqual(results[0]!.body);
    expect(await f.count(a, m, ctx)).toBe(1);
  });

  it('a key is only ever used within its own business', async () => {
    const ctxA = await prepare(a);
    const ctxB = await prepare(b);
    const m = marker();
    const key = newKey();
    const first = await post(a, f.path(ctxA), { ...f.body(m, ctxA), idempotencyKey: key });
    const other = await post(b, f.path(ctxB), { ...f.body(m, ctxB), idempotencyKey: key });
    expect(first.status).toBeLessThan(300);
    expect(other.status).toBe(first.status);
    expect(other.body.id).not.toBe(first.body.id);
    expect(await f.count(a, m, ctxA)).toBe(1);
    expect(await f.count(b, m, ctxB)).toBe(1);
  });

  it('without a key it behaves as before and stores nothing', async () => {
    const ctx = await prepare(a);
    const m = marker();
    const before = await inTenant(a, (tx) => tx.idempotencyKey.count());
    const first = await post(a, f.path(ctx), f.body(m, ctx));
    expect(first.status).toBeLessThan(300);
    const second = await post(a, f.path(ctx), f.body(m, ctx));
    // Not a replay: either a second row (products with new ids) or the old "already exists" answer.
    expect(second.body.id === first.body.id && second.status === first.status).toBe(false);
    expect(await inTenant(a, (tx) => tx.idempotencyKey.count())).toBe(before);
  });
});

describe('what a key does not do', () => {
  it('a create that fails leaves no key behind, so the retry runs for real', async () => {
    const sku = `DUP-${uniq()}`;
    await post(a, '/v1/products', {
      name: 'First',
      variants: [{ sku, priceMinor: 100 }],
    }).expect(201);
    const key = newKey();
    const body = { name: 'Second', variants: [{ sku, priceMinor: 100 }], idempotencyKey: key };
    await post(a, '/v1/products', body).expect(409);
    expect(await inTenant(a, (tx) => tx.idempotencyKey.count({ where: { key } }))).toBe(0);
    // The same key with a corrected request runs for real, because nothing was stored for the failed one.
    const fixed = await post(a, '/v1/products', {
      ...body,
      variants: [{ sku: `${sku}-B`, priceMinor: 100 }],
    });
    expect(fixed.status).toBe(201);
  });

  it('a malformed key is a validation error', async () => {
    const res = await post(a, '/v1/categories', { name: `Bad ${uniq()}`, idempotencyKey: 'no' });
    expect(res.status).toBe(400);
  });

  it('an invitation sent again with the same key sends one email, not two', async () => {
    const email = `once-${uniq()}@example.test`;
    const key = newKey();
    const body = { email, role: 'STAFF', idempotencyKey: key };
    await post(a, '/v1/members/invitations', body).expect(201);
    await post(a, '/v1/members/invitations', body).expect(201);
    expect(t.mail.to(email, 'invitation')).toHaveLength(1);
  });

  it('a product import is queued once, however often the request is repeated', async () => {
    await inTenant(a, (tx) => tx.importJob.updateMany({ data: { status: 'COMPLETED' } }));
    const key = newKey();
    const before = queued.length;
    const body = { csv: `product_name,sku,price\nQ ${uniq()},Q-${uniq()},5`, idempotencyKey: key };
    const first = await post(a, '/v1/imports/products', body).expect(202);
    const again = await post(a, '/v1/imports/products', body).expect(202);
    expect(again.body.id).toBe(first.body.id);
    expect(queued.length).toBe(before + 1);
    // The stored answer never holds the file itself.
    const stored = await inTenant(a, (tx) => tx.idempotencyKey.findFirst({ where: { key } }));
    expect(JSON.stringify(stored?.responseBody)).not.toContain('product_name');
  });
});

describe('creating a business', () => {
  const create = (who: Who, body: object) => post(who, '/v1/workspaces', body);

  it('the same key twice makes one business and returns it again', async () => {
    const owner = await registerTenant(t);
    const key = newKey();
    const name = `Shop ${uniq()}`;
    const first = await create(owner, { name, idempotencyKey: key });
    expect(first.status).toBe(201);
    const second = await create(owner, { name, idempotencyKey: key });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const mine = (await t.http.get('/v1/workspaces').set(bearer(owner.accessToken)).expect(200))
      .body as { name: string }[];
    expect(mine.filter((w) => w.name === name)).toHaveLength(1);
  });

  it('simultaneous identical requests make one business', async () => {
    const owner = await registerTenant(t);
    const key = newKey();
    const name = `Race ${uniq()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create(owner, { name, idempotencyKey: key })),
    );
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const mine = (await t.http.get('/v1/workspaces').set(bearer(owner.accessToken)).expect(200))
      .body as { name: string }[];
    expect(mine.filter((w) => w.name === name)).toHaveLength(1);
  });

  it('a different request under the same key is 409, and another person can use the key freely', async () => {
    const one = await registerTenant(t);
    const two = await registerTenant(t);
    const key = newKey();
    await create(one, { name: `A ${uniq()}`, idempotencyKey: key }).expect(201);
    const clash = await create(one, { name: `B ${uniq()}`, idempotencyKey: key });
    expect(clash.status).toBe(409);
    expect(clash.body.code ?? clash.body.type).toMatch(/idempotency_conflict/);
    await create(two, { name: `C ${uniq()}`, idempotencyKey: key }).expect(201);
  });

  it('without a key two requests make two businesses, as before', async () => {
    const owner = await registerTenant(t);
    const name = `Twin ${uniq()}`;
    await create(owner, { name }).expect(201);
    await create(owner, { name }).expect(201);
    const mine = (await t.http.get('/v1/workspaces').set(bearer(owner.accessToken)).expect(200))
      .body as { name: string }[];
    expect(mine.filter((w) => w.name === name)).toHaveLength(2);
  });
});

describe('the idempotency_keys table', () => {
  it('shows each business only its own keys, and a person only their own business-less keys', async () => {
    const x = await registerTenant(t);
    const y = await registerTenant(t);
    const kx = newKey();
    const ky = newKey();
    await post(x, '/v1/categories', { name: `X ${uniq()}`, idempotencyKey: kx }).expect(201);
    await post(y, '/v1/categories', { name: `Y ${uniq()}`, idempotencyKey: ky }).expect(201);
    await post(x, '/v1/workspaces', { name: `W ${uniq()}`, idempotencyKey: kx }).expect(201);

    const keysSeenBy = (ctx: { tenantId?: string; userId?: string }) =>
      t.db.withContext(ctx, async (tx) =>
        (await tx.$queryRaw<{ key: string }[]>`SELECT key FROM idempotency_keys`).map((r) => r.key),
      );
    expect(await keysSeenBy({})).toEqual([]);
    const xs = await keysSeenBy({ tenantId: x.tenant.id });
    expect(xs).toContain(kx);
    expect(xs).not.toContain(ky);
    expect(await keysSeenBy({ tenantId: y.tenant.id })).not.toContain(kx);
    // The person's own key for creating a business is theirs alone.
    const personal = await keysSeenBy({ userId: x.user.id });
    expect(personal).toEqual([kx]);
    expect(await keysSeenBy({ userId: y.user.id })).toEqual([]);
  });

  it('cannot be written for another business', async () => {
    const x = await registerTenant(t);
    const y = await registerTenant(t);
    await expect(
      t.db.withContext({ tenantId: x.tenant.id }, (tx) =>
        tx.idempotencyKey.create({
          data: {
            tenantId: y.tenant.id,
            scope: 's',
            key: 'forged-key',
            requestHash: 'h',
            responseBody: {},
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('is purged after a day, by the function the worker calls, and nothing younger', async () => {
    // Keys left over from earlier runs of this suite are older than an hour: clear them so the counts below are ours.
    await t.db.purgeIdempotencyKeys(0);
    const x = await registerTenant(t);
    const old = newKey();
    const fresh = newKey();
    await post(x, '/v1/categories', { name: `Old ${uniq()}`, idempotencyKey: old }).expect(201);
    await post(x, '/v1/categories', { name: `New ${uniq()}`, idempotencyKey: fresh }).expect(201);
    await t.db.withContext(
      { tenantId: x.tenant.id },
      (tx) =>
        tx.$executeRaw`UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = ${old}`,
    );
    expect(await t.db.purgeIdempotencyKeys(24 * 3600)).toBeGreaterThanOrEqual(1);
    const left = await t.db.withContext({ tenantId: x.tenant.id }, (tx) =>
      tx.idempotencyKey.findMany({ select: { key: true } }),
    );
    expect(left.map((r) => r.key)).toEqual([fresh]);
    // Asking for less than an hour still removes only what is older than an hour.
    expect(await t.db.purgeIdempotencyKeys(0)).toBe(0);
  });
});
