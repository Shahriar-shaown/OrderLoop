import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './index.js';

const json = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('api client health', () => {
  it('parses live', async () => {
    const api = createApiClient({ baseUrl: 'http://x/', fetch: json({ status: 'ok' }) });
    expect(await api.health.live()).toEqual({ status: 'ok' });
  });

  it('returns a degraded ready response on 503', async () => {
    const body = { status: 'degraded', checks: { postgres: 'up', redis: 'down' } };
    const api = createApiClient({ baseUrl: 'http://x', fetch: json(body, 503) });
    expect(await api.health.ready()).toEqual(body);
  });

  it('rejects a body that violates the contract', async () => {
    const api = createApiClient({ baseUrl: 'http://x', fetch: json({ nope: true }) });
    await expect(api.health.live()).rejects.toBeInstanceOf(ApiError);
  });

  it('wraps network failures', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: 'http://x', fetch: failing });
    await expect(api.health.live()).rejects.toThrow(/unreachable/);
  });
});
