import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestApp,
  PASSWORD,
  registerTenant,
  uniqueEmail,
  type TestApp,
} from './app.js';

/** A separate app instance with the limiter ON (the shared test config turns it off), so its counters are isolated. */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ RATE_LIMIT_ENABLED: 'true' });
});
afterAll(() => t.close());

async function hammer(path: string, makeBody: () => object, count: number) {
  const statuses: number[] = [];
  let last;
  for (let i = 0; i < count; i++) {
    // A fresh body each time, so the per-account login lockout does not mask the per-IP request limit under test.
    last = await t.http.post(path).send(makeBody());
    statuses.push(last.status);
  }
  return { statuses, last: last! };
}

describe('rate limiting on sensitive authentication endpoints', () => {
  it.each([
    [
      'login',
      '/v1/auth/login',
      () => ({ email: uniqueEmail('nobody'), password: 'wrong wrong wrong' }),
    ],
    ['forgot-password', '/v1/auth/forgot-password', () => ({ email: uniqueEmail('nobody') })],
    [
      'reset-password',
      '/v1/auth/reset-password',
      () => ({ token: 'z'.repeat(43), password: PASSWORD }),
    ],
    ['verify-email', '/v1/auth/verify-email', () => ({ token: 'z'.repeat(43) })],
    [
      'accept-invitation',
      '/v1/auth/accept-invitation',
      () => ({ token: 'inv_nonsense', password: PASSWORD }),
    ],
  ])(
    '%s is limited to 10 requests per minute per IP, then answers 429 with problem details',
    async (_name, path, body) => {
      const { statuses, last } = await hammer(path, body, 12);
      expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
      expect(last.headers['content-type']).toMatch(/problem\+json/);
      expect(last.body).toMatchObject({ status: 429, code: 'rate_limited' });
      expect(last.headers['retry-after']).toBeDefined();
    },
  );

  it('register, which sends a verification email, is limited to 3 requests per minute per IP', async () => {
    const { statuses, last } = await hammer(
      '/v1/auth/register',
      () => ({ email: 'not-an-email', password: 'x', name: '', tenantName: '' }),
      5,
    );
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect(last.body).toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('refresh has its own, higher budget (30 per minute)', async () => {
    const { statuses } = await hammer(
      '/v1/auth/refresh',
      () => ({ refreshToken: 'never-issued' }),
      32,
    );
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });

  it('a limited caller does not affect public health checks used by load balancers', async () => {
    expect((await t.http.get('/health/live')).status).toBe(200);
  });
});

describe('per-business budgets on expensive endpoints', () => {
  let budget: TestApp;
  beforeAll(async () => {
    budget = await createTestApp({ RATE_LIMIT_ENABLED: 'true' });
  });
  afterAll(() => budget.close());

  it('imports.validate and each export allow 5 per minute per business, however many callers, and another business is unaffected', async () => {
    const [a, b] = [await registerTenant(budget), await registerTenant(budget)];
    const call = (who: typeof a, method: 'get' | 'post', path: string) =>
      budget.http[method](path)
        .set(bearer(who.accessToken))
        .send(method === 'post' ? { csv: 'product_name,sku,price\nTee,TEE-1,100\n' } : undefined);
    for (const [method, path] of [
      ['post', '/v1/imports/products/validate'],
      ['get', '/v1/exports/products'],
      ['get', '/v1/exports/stock'],
      ['get', '/v1/exports/orders'],
    ] as const) {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await call(a, method, path)).status);
      expect(
        statuses.slice(0, 5).every((s) => s === 200),
        `${path}: ${statuses}`,
      ).toBe(true);
      expect(statuses[5], path).toBe(429);
      expect((await call(b, method, path)).status, `${path} for another business`).toBe(200);
    }
  });
});
