import { describe, expect, it, vi } from 'vitest';
import { CourierError } from './errors.js';
import { Http, RateLimiter, parseRetryAfter } from './http.js';
import { fakeNetwork, refusedError, resetError, timeoutError } from './testing.js';

const sleeps: number[] = [];
const sleep = async (ms: number) => void sleeps.push(ms);
const make = (routes: Parameters<typeof fakeNetwork>[0]) => {
  const net = fakeNetwork(routes);
  sleeps.length = 0;
  return { net, http: new Http({ baseUrl: 'https://courier.test', fetch: net.fetch, sleep }) };
};
const fail = async (p: Promise<unknown>): Promise<CourierError> => {
  try {
    await p;
  } catch (e) {
    return e as CourierError;
  }
  throw new Error('expected a failure');
};

describe('http: classifying what the provider said', () => {
  const kinds: [number, string][] = [
    [400, 'validation'],
    [409, 'validation'],
    [422, 'validation'],
    [401, 'auth'],
    [402, 'forbidden'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [418, 'unexpected'],
  ];
  for (const [status, kind] of kinds)
    it(`${status} is ${kind}`, async () => {
      const { http } = make({ 'POST /x': { status, body: { message: 'because' } } });
      const e = await fail(http.request({ method: 'POST', path: '/x', kind: 'create' }));
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
    });

  it('keeps the provider’s field errors and a short message, and nothing else', async () => {
    const { http } = make({
      'POST /x': {
        status: 422,
        body: {
          message: 'The given data was invalid',
          errors: { recipient_phone: ['The recipient phone is invalid'] },
          secret_token: 'abc',
        },
      },
    });
    const e = await fail(http.request({ method: 'POST', path: '/x', kind: 'create' }));
    expect(e.message).toBe('The given data was invalid');
    expect(e.fields).toEqual([
      { field: 'recipient_phone', message: 'The recipient phone is invalid' },
    ]);
    expect(JSON.stringify(e)).not.toContain('abc');
  });

  it('refuses a redirect instead of following it with credentials', async () => {
    const { http, net } = make({
      'GET /x': { status: 302, headers: { location: 'https://evil.test/steal' } },
    });
    const e = await fail(
      http.request({ method: 'GET', path: '/x', headers: { 'Api-Key': 'k' }, kind: 'idempotent' }),
    );
    expect(e.kind).toBe('unexpected');
    expect(net.requests).toHaveLength(1);
    expect(net.requests.every((r) => r.url.startsWith('https://courier.test'))).toBe(true);
  });

  it('treats a reply that is not JSON as unavailable', async () => {
    const { http } = make({ 'GET /x': { status: 200, raw: '<html>maintenance</html>' } });
    const e = await fail(http.request({ method: 'GET', path: '/x', kind: 'idempotent' }));
    expect(e.kind).toBe('unavailable');
  });

  it('sends JSON, an identifying user agent, and never follows redirects', async () => {
    const { http, net } = make({ 'POST /x': { body: { ok: true } } });
    await http.request({ method: 'POST', path: '/x', body: { a: 1 }, kind: 'create' });
    expect(net.requests[0]).toMatchObject({
      method: 'POST',
      body: { a: 1 },
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    expect(net.requests[0]!.headers['user-agent']).toMatch(/OrderLoop/);
  });
});

describe('http: reading is retried, booking is not', () => {
  it('retries a read through a 503 and a timeout, backing off', async () => {
    const { http, net } = make({
      'GET /x': [{ status: 503 }, timeoutError(), { body: { ok: 1 } }],
    });
    expect(await http.request({ method: 'GET', path: '/x', kind: 'idempotent' })).toEqual({
      ok: 1,
    });
    expect(net.requests).toHaveLength(3);
    expect(sleeps).toEqual([500, 1500]);
  });

  it('gives up on a read after three tries and says the courier is unavailable', async () => {
    const { http, net } = make({ 'GET /x': { status: 502 } });
    const e = await fail(http.request({ method: 'GET', path: '/x', kind: 'idempotent' }));
    expect(e.kind).toBe('unavailable');
    expect(net.requests).toHaveLength(3);
  });

  it('never retries a read that the provider refused as invalid or unauthorised', async () => {
    for (const status of [400, 401, 403, 404]) {
      const { http, net } = make({ 'GET /x': { status } });
      await fail(http.request({ method: 'GET', path: '/x', kind: 'idempotent' }));
      expect(net.requests, String(status)).toHaveLength(1);
    }
  });

  it('does NOT retry a booking after a 5xx: it may exist', async () => {
    const { http, net } = make({ 'POST /x': { status: 500 } });
    const e = await fail(http.request({ method: 'POST', path: '/x', kind: 'create' }));
    expect(net.requests).toHaveLength(1);
    expect(e.outcomeUnknown).toBe(true);
  });

  it('does NOT retry a booking after a timeout or a dropped connection, and says the outcome is unknown', async () => {
    for (const err of [timeoutError(), resetError()]) {
      const { http, net } = make({ 'POST /x': err });
      const e = await fail(http.request({ method: 'POST', path: '/x', kind: 'create' }));
      expect(net.requests).toHaveLength(1);
      expect(e.kind).toBe('unavailable');
      expect(e.outcomeUnknown).toBe(true);
    }
  });

  it('retries a booking only when it certainly never left (connection refused)', async () => {
    const { http, net } = make({ 'POST /x': [refusedError(), { body: { ok: 1 } }] });
    expect(await http.request({ method: 'POST', path: '/x', body: {}, kind: 'create' })).toEqual({
      ok: 1,
    });
    expect(net.requests).toHaveLength(2);
  });

  it('retries a booking after a 429, waiting as long as the provider asked', async () => {
    const { http, net } = make({
      'POST /x': [{ status: 429, headers: { 'retry-after': '7' } }, { body: { ok: 1 } }],
    });
    await http.request({ method: 'POST', path: '/x', body: {}, kind: 'create' });
    expect(net.requests).toHaveLength(2);
    expect(sleeps).toEqual([7000]);
  });

  it('does not retry early when the provider asks for more than 30 seconds: it surfaces the rate limit', async () => {
    const { http, net } = make({ 'GET /x': { status: 429, headers: { 'retry-after': '600' } } });
    const e = await fail(http.request({ method: 'GET', path: '/x', kind: 'idempotent' }));
    expect(e.kind).toBe('rate_limited');
    expect(e.retryAfterSeconds).toBe(600);
    expect(net.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('waits for a Retry-After of exactly 30 seconds, and reads an HTTP date', async () => {
    const { http } = make({
      'GET /x': [{ status: 429, headers: { 'retry-after': '30' } }, { body: { ok: 1 } }],
    });
    await http.request({ method: 'GET', path: '/x', kind: 'idempotent' });
    expect(sleeps).toEqual([30_000]);
    const now = Date.parse('2026-10-18T10:00:00Z');
    expect(parseRetryAfter('Sun, 18 Oct 2026 10:00:20 GMT', now)).toBe(20);
    expect(parseRetryAfter('Sun, 18 Oct 2026 09:00:00 GMT', now)).toBeUndefined(); // already past
    expect(parseRetryAfter('7', now)).toBe(7);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('a conflict on a booking may mean it already went through; on a read it is just a refusal', async () => {
    const { http } = make({
      'POST /x': { status: 409, body: {} },
      'GET /y': { status: 409, body: {} },
    });
    expect(
      (await fail(http.request({ method: 'POST', path: '/x', kind: 'create' }))).outcomeUnknown,
    ).toBe(true);
    expect(
      (await fail(http.request({ method: 'GET', path: '/y', kind: 'idempotent' }))).outcomeUnknown,
    ).toBe(false);
  });

  it('a timeout on a read is not an unknown outcome', async () => {
    const { http } = make({ 'GET /x': timeoutError() });
    const e = await fail(http.request({ method: 'GET', path: '/x', kind: 'idempotent' }));
    expect(e.outcomeUnknown).toBe(false);
  });
});

describe('rate limiter', () => {
  it('lets a burst through up to the limit, then waits for the oldest request to age out', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(
      3,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
      120_000,
    );
    for (let i = 0; i < 3; i++) await limiter.acquire();
    expect(waits).toEqual([]);
    await limiter.acquire();
    expect(waits).toEqual([60_000]);
  });

  it('refuses rather than waiting minutes', async () => {
    const limiter = new RateLimiter(
      1,
      () => 0,
      async () => undefined,
      5_000,
    );
    await limiter.acquire();
    const e = await fail(limiter.acquire());
    expect(e.kind).toBe('rate_limited');
    expect(e.retryAfterSeconds).toBe(60);
  });

  it('is applied before every request an Http makes', async () => {
    const before = vi.fn(async () => undefined);
    const net = fakeNetwork({ 'GET /x': { body: {} } });
    const http = new Http({
      baseUrl: 'https://courier.test',
      fetch: net.fetch,
      beforeRequest: before,
    });
    await http.request({ method: 'GET', path: '/x', kind: 'idempotent' });
    await http.request({ method: 'GET', path: '/x', kind: 'idempotent' });
    expect(before).toHaveBeenCalledTimes(2);
  });
});
