import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, registerTenant, type TestApp } from './app.js';

/** Regression tests for the findings of the security review (docs/known-issues.md lists what is documented rather than changed). */
let t: TestApp;
const lines: string[] = [];
beforeAll(async () => {
  t = await createTestApp(
    {},
    {
      logDestination: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    },
  );
});
afterAll(() => t.close());

describe("products cannot point at another business's category or supplier (database trigger)", () => {
  const stamp = Date.now();
  const make = (tenantId: string, extra: object) =>
    t.db.withContext({ tenantId }, (tx) =>
      tx.product.create({
        data: { tenantId, name: `P ${stamp}`, nameKey: `p ${stamp}`, ...extra },
      }),
    );

  it('refuses a cross-tenant category or supplier on insert and on update, even if the service forgot to check', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    const catB = (
      await t.http
        .post('/v1/categories')
        .set(bearer(b.accessToken))
        .send({ name: `Cat ${stamp}` })
        .expect(201)
    ).body.id as string;
    const supB = (
      await t.http
        .post('/v1/suppliers')
        .set(bearer(b.accessToken))
        .send({ name: `Sup ${stamp}` })
        .expect(201)
    ).body.id as string;

    await expect(make(a.tenant.id, { categoryId: catB })).rejects.toThrow(/category|foreign key/i);
    await expect(make(a.tenant.id, { supplierId: supB })).rejects.toThrow(/supplier|foreign key/i);

    // the same business's own category is fine, and an update to a foreign one is refused too
    const catA = (
      await t.http
        .post('/v1/categories')
        .set(bearer(a.accessToken))
        .send({ name: `Own ${stamp}` })
        .expect(201)
    ).body.id as string;
    const product = await make(a.tenant.id, { categoryId: catA });
    await expect(
      t.db.withContext({ tenantId: a.tenant.id }, (tx) =>
        tx.product.update({
          where: { id: product.id, tenantId: a.tenant.id },
          data: { categoryId: catB },
        }),
      ),
    ).rejects.toThrow(/category|foreign key/i);
  });

  it('the API still answers a cross-tenant id as not found / invalid, not as a server error', async () => {
    const a = await registerTenant(t);
    const b = await registerTenant(t);
    const catB = (
      await t.http
        .post('/v1/categories')
        .set(bearer(b.accessToken))
        .send({ name: `Cat2 ${stamp}` })
        .expect(201)
    ).body.id as string;
    const r = await t.http
      .post('/v1/products')
      .set(bearer(a.accessToken))
      .send({
        name: 'X',
        categoryId: catB,
        variants: [{ sku: `SKU-${stamp}`, priceMinor: 100 }],
      });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});

describe('settlement import body limit', () => {
  it('accepts a body up to the schema limit for callers with a token, and refuses an anonymous large one before reading it', async () => {
    const o = await registerTenant(t);
    const csv = 'a'.repeat(2_400_000);
    const big = await t.http
      .post('/v1/settlements/import')
      .set(bearer(o.accessToken))
      .send({ provider: 'steadfast', csv, dryRun: true });
    expect(big.status).not.toBe(413); // it used to be cut at 100 KB
    // A server that refuses a large body early may close the connection while the client is still sending it: the client then
    // sees a reset instead of the response. Both are a refusal; what matters is that it is not accepted.
    const refusal = (request: Promise<{ status: number }>) =>
      request.then(
        (r) => r.status,
        (e: { code?: string }) => e.code ?? 'ERROR',
      );
    const anonymous = await refusal(
      t.http.post('/v1/settlements/import').send({ provider: 'steadfast', csv }),
    );
    expect([401, 'EPIPE', 'ECONNRESET']).toContain(anonymous);
    const tooBig = await refusal(
      t.http
        .post('/v1/settlements/import')
        .set(bearer(o.accessToken))
        .send({ provider: 'steadfast', csv: 'a'.repeat(3_200_000) }),
    );
    expect([413, 'EPIPE', 'ECONNRESET']).toContain(tooBig);
  });
});

describe('request log', () => {
  it('does not log a push token that travels in the path', async () => {
    const o = await registerTenant(t);
    lines.length = 0;
    const token = 'ExponentPushToken[SECRET-device-token-0123]';
    await t.http.delete(`/v1/push-devices/${encodeURIComponent(token)}`).set(bearer(o.accessToken));
    const all = lines.join('');
    expect(all).toContain('/v1/push-devices/[REDACTED]');
    expect(all).not.toContain('SECRET-device-token');
    expect(all).not.toContain(encodeURIComponent('SECRET-device-token'));
  });
});

describe('GET /openapi.json', () => {
  it('is public by default and 404 with OPENAPI_PUBLIC=false', async () => {
    expect((await t.http.get('/openapi.json')).status).toBe(200);
    const hidden = await createTestApp({ OPENAPI_PUBLIC: 'false' });
    try {
      expect((await hidden.http.get('/openapi.json')).status).toBe(404);
    } finally {
      await hidden.close();
      delete process.env['OPENAPI_PUBLIC'];
    }
  });
});

describe('GET /health/ready', () => {
  it('answers repeated calls from one probe (cached for 2 seconds)', async () => {
    const first = await t.http.get('/health/ready');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => t.http.get('/health/ready')),
    );
    expect(first.status).toBe(200);
    expect(results.every((r) => r.status === 200 && r.body.status === 'ok')).toBe(true);
  });
});
