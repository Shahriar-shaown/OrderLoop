import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './index.js';

type Seen = { url: string; init: RequestInit };
function stub(status: number, body: unknown, seen: Seen[] = []) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const ME = {
  user: {
    id: '0197b0a0-0000-7000-8000-000000000001',
    email: 'a@b.test',
    name: 'A',
    emailVerified: true,
  },
  tenant: { id: '0197b0a0-0000-7000-8000-000000000002', name: 'T' },
  role: 'OWNER',
  permissions: ['tenant:read'],
  memberships: [{ tenantId: '0197b0a0-0000-7000-8000-000000000002', role: 'OWNER' }],
};

describe('health', () => {
  it('parses live', async () => {
    const { fetchImpl } = stub(200, { status: 'ok' });
    expect(await createApiClient({ baseUrl: 'http://x/', fetch: fetchImpl }).health.live()).toEqual(
      { status: 'ok' },
    );
  });

  it('returns a degraded ready response on 503 instead of throwing', async () => {
    const body = { status: 'degraded', checks: { postgres: 'up', redis: 'down' } };
    const { fetchImpl } = stub(503, body);
    expect(await createApiClient({ baseUrl: 'http://x', fetch: fetchImpl }).health.ready()).toEqual(
      body,
    );
  });

  it('rejects a body that violates the contract', async () => {
    const { fetchImpl } = stub(200, { nope: true });
    await expect(
      createApiClient({ baseUrl: 'http://x', fetch: fetchImpl }).health.live(),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('wraps network failures', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      createApiClient({ baseUrl: 'http://x', fetch: failing }).health.live(),
    ).rejects.toMatchObject({ code: 'network_error' });
  });
});

describe('authenticated calls', () => {
  it('sends the bearer token only to routes that need one', async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = stub(200, ME, seen);
    const api = createApiClient({
      baseUrl: 'http://x',
      fetch: fetchImpl,
      getAccessToken: () => 'tok123',
    });
    await api.me();
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok123');

    const live = stub(200, { status: 'ok' }, seen);
    await createApiClient({
      baseUrl: 'http://x',
      fetch: live.fetchImpl,
      getAccessToken: () => 'tok123',
    }).health.live();
    expect((seen[1]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('substitutes and encodes path params, and serialises the body', async () => {
    const seen: Seen[] = [];
    const member = {
      id: '0197b0a0-0000-7000-8000-000000000003',
      userId: '0197b0a0-0000-7000-8000-000000000001',
      email: 'a@b.test',
      name: 'A',
      role: 'STAFF',
      joinedAt: '2026-01-01T00:00:00Z',
    };
    const { fetchImpl } = stub(200, member, seen);
    await createApiClient({ baseUrl: 'http://x', fetch: fetchImpl }).members.updateRole(
      member.id,
      'STAFF',
    );
    expect(seen[0]!.url).toBe(`http://x/v1/members/${member.id}`);
    expect(seen[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ role: 'STAFF' });
  });

  it('adds query parameters and omits undefined ones', async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = stub(200, { items: [], nextCursor: null }, seen);
    await createApiClient({ baseUrl: 'http://x', fetch: fetchImpl }).auditLogs.list({ limit: 5 });
    expect(seen[0]!.url).toBe('http://x/v1/audit-logs?limit=5');
  });

  it('forwards custom headers (e.g. x-client: web)', async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = stub(200, { status: 'ok' }, seen);
    await createApiClient({
      baseUrl: 'http://x',
      fetch: fetchImpl,
      headers: { 'x-client': 'web' },
    }).health.live();
    expect((seen[0]!.init.headers as Record<string, string>)['x-client']).toBe('web');
  });
});

describe('email verification and password reset', () => {
  it('posts the token or email in the body and needs no bearer token', async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = stub(200, {}, seen);
    const api = createApiClient({
      baseUrl: 'http://x',
      fetch: fetchImpl,
      getAccessToken: () => 'tok123',
    });
    await api.auth.verifyEmail('t'.repeat(30));
    await api.auth.forgotPassword('A@B.test');
    await api.auth.resetPassword('r'.repeat(30), 'a long enough password');
    expect(seen.map((s) => s.url)).toEqual([
      'http://x/v1/auth/verify-email',
      'http://x/v1/auth/forgot-password',
      'http://x/v1/auth/reset-password',
    ]);
    expect(JSON.parse(seen[1]!.init.body as string)).toEqual({ email: 'a@b.test' }); // normalised before sending
    for (const s of seen)
      expect((s.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('rejects a too-short reset password locally, before any request', async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = stub(200, {}, seen);
    const err = await createApiClient({ baseUrl: 'http://x', fetch: fetchImpl })
      .auth.resetPassword('r'.repeat(30), 'short')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'validation_failed' });
    expect(seen).toHaveLength(0);
  });

  it('resend-verification sends the bearer token', async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = stub(200, {}, seen);
    await createApiClient({
      baseUrl: 'http://x',
      fetch: fetchImpl,
      getAccessToken: () => 'tok123',
    }).auth.resendVerification();
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok123');
  });
});

describe('errors', () => {
  it('turns RFC 9457 problem details into an ApiError with code and field errors', async () => {
    const { fetchImpl } = stub(400, {
      type: 'urn:orderloop:error:validation_failed',
      title: 'validation_failed',
      status: 400,
      code: 'validation_failed',
      detail: 'Request validation failed',
      errors: [{ path: 'body.email', message: 'Invalid email' }],
    });
    const err = await createApiClient({ baseUrl: 'http://x', fetch: fetchImpl })
      .auth.login({ email: 'a@b.test', password: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 400,
      code: 'validation_failed',
      errors: [{ path: 'body.email', message: 'Invalid email' }],
    });
  });

  it('validates input locally before any request is made', async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = stub(200, {}, seen);
    const err = await createApiClient({ baseUrl: 'http://x', fetch: fetchImpl })
      .auth.login({ email: 'not-an-email', password: 'x' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'validation_failed' });
    expect(seen).toHaveLength(0);
  });

  it('handles a non-JSON error body', async () => {
    const html = (async () =>
      new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
    await expect(createApiClient({ baseUrl: 'http://x', fetch: html }).me()).rejects.toMatchObject({
      status: 502,
      code: 'unexpected_response',
    });
  });
});
