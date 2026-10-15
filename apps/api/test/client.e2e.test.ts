import { ApiError, createApiClient } from '@orderloop/api-client';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, PASSWORD, uniqueEmail, type TestApp } from './app.js';

/** The typed client from packages/api-client driven against the real API over HTTP: contract and server cannot drift. */
let t: TestApp;
let baseUrl: string;
beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen(0);
  baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(() => t.close());

describe('api-client against the live API', () => {
  it('registers, authenticates, and calls protected routes with typed results', async () => {
    let token: string | undefined;
    const api = createApiClient({ baseUrl, getAccessToken: () => token });

    const registered = await api.auth.register({
      email: uniqueEmail('client'),
      password: PASSWORD,
      name: 'Client User',
      tenantName: 'Client Shop',
    });
    token = registered.accessToken;
    expect(registered.role).toBe('OWNER');

    const me = await api.me();
    expect(me.tenant.name).toBe('Client Shop');
    expect(me.permissions).toContain('audit:read');
    expect((await api.tenant()).id).toBe(registered.tenant.id);
    expect(await api.members.list()).toHaveLength(1);
    expect((await api.auditLogs.list({ limit: 1 })).items).toHaveLength(1);
  });

  it('refresh rotates tokens through the client and a replay surfaces as a typed error code', async () => {
    const api = createApiClient({ baseUrl });
    const email = uniqueEmail('client2');
    const first = await api.auth.register({
      email,
      password: PASSWORD,
      name: 'C',
      tenantName: 'S',
    });
    const rotated = await api.auth.refresh({ refreshToken: first.refreshToken! });
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    const replay = await api.auth
      .refresh({ refreshToken: first.refreshToken! })
      .catch((e: unknown) => e);
    expect(replay).toBeInstanceOf(ApiError);
    expect(replay).toMatchObject({ status: 401, code: 'token_reuse_detected' });
  });

  it('surfaces an authentication failure as a typed ApiError', async () => {
    const api = createApiClient({ baseUrl, getAccessToken: () => undefined });
    expect(await api.me().catch((e: unknown) => e)).toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
  });

  it('the OpenAPI document served by the API matches the committed docs/openapi.json', async () => {
    const served = await (await fetch(`${baseUrl}/openapi.json`)).json();
    const committed = JSON.parse(
      (await import('node:fs')).readFileSync(
        new URL('../../../docs/openapi.json', import.meta.url),
        'utf8',
      ),
    );
    expect(served).toEqual(committed);
  });
});
