import type { AuthResult } from '@orderloop/contracts';
import { describe, expect, it, vi } from 'vitest';
import { SessionManager, isAuthRejection, withTokenRetry } from './session';

const session = (token: string, expiresIn = 900): AuthResult =>
  ({
    accessToken: token,
    expiresIn,
    user: { id: 'u', email: 'a@b.c', name: 'A', emailVerified: true },
    tenant: { id: 't', name: 'T' },
    role: 'OWNER',
    memberships: [],
  }) as AuthResult;

const reject = (status: number) => Object.assign(new Error('rejected'), { status });

function setup(refresh = vi.fn(async () => session('fresh'))) {
  const logout = vi.fn(async () => undefined);
  const manager = new SessionManager({ refresh, logout });
  return { manager, refresh, logout };
}

describe('SessionManager', () => {
  it('starts loading, with no session and no token', () => {
    const { manager } = setup();
    expect(manager.getSnapshot()).toEqual({ status: 'loading', session: null });
    expect(manager.getAccessToken()).toBeUndefined();
  });

  it('restores a session by refreshing, and keeps the token only in memory', async () => {
    const { manager } = setup();
    await manager.init();
    expect(manager.getSnapshot().status).toBe('authenticated');
    expect(manager.getAccessToken()).toBe('fresh');
    manager.dispose();
  });

  it('shares one request between concurrent refreshes (refresh tokens are single use)', async () => {
    let release!: (s: AuthResult) => void;
    const refresh = vi.fn(() => new Promise<AuthResult>((r) => (release = r)));
    const { manager } = setup(refresh);
    const a = manager.refresh();
    const b = manager.refresh();
    const c = manager.init();
    release(session('one'));
    expect(await Promise.all([a, b, c])).toEqual([
      expect.objectContaining({ accessToken: 'one' }),
      expect.objectContaining({ accessToken: 'one' }),
      expect.objectContaining({ accessToken: 'one' }),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it('allows a new refresh once the previous one finished', async () => {
    const { manager, refresh } = setup();
    await manager.refresh();
    await manager.refresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it('becomes anonymous when the server refuses the refresh token', async () => {
    const { manager } = setup(vi.fn(async () => Promise.reject(reject(401))));
    expect(await manager.refresh()).toBeNull();
    expect(manager.getSnapshot().status).toBe('anonymous');
  });

  it('does not sign anyone out because of a network failure', async () => {
    const { manager } = setup(vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await manager.start(session('kept'));
    await expect(manager.refresh()).rejects.toThrow('Failed to fetch');
    expect(manager.getSnapshot().status).toBe('authenticated');
    expect(manager.getAccessToken()).toBe('kept');
    manager.dispose();
  });

  it('start adopts a session; logout clears it locally even if the server call fails', async () => {
    const { manager, logout } = setup();
    manager.start(session('signed-in'));
    expect(manager.getAccessToken()).toBe('signed-in');
    logout.mockRejectedValueOnce(new Error('offline'));
    await manager.logout();
    expect(manager.getSnapshot()).toEqual({ status: 'anonymous', session: null });
    manager.dispose();
  });

  it('notifies subscribers of every change, and not after they unsubscribe', () => {
    const { manager } = setup();
    const listener = vi.fn();
    const off = manager.subscribe(listener);
    manager.start(session('a'));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    manager.start(session('b'));
    expect(listener).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it('refreshes by itself shortly before the access token expires', async () => {
    vi.useFakeTimers();
    try {
      const { manager, refresh } = setup();
      manager.start(session('short', 120));
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(61_000); // 120s lifetime, 60s margin
      expect(refresh).toHaveBeenCalledTimes(1);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isAuthRejection', () => {
  it('is true for 401 and 403 only', () => {
    expect(isAuthRejection(reject(401))).toBe(true);
    expect(isAuthRejection(reject(403))).toBe(true);
    expect(isAuthRejection(reject(500))).toBe(false);
    expect(isAuthRejection(new TypeError('x'))).toBe(false);
    expect(isAuthRejection(null)).toBe(false);
  });
});

describe('withTokenRetry', () => {
  const ok = () => new Response('{}', { status: 200 });
  const unauthorized = () => new Response('{}', { status: 401 });
  const authed = { headers: { authorization: 'Bearer old' } };

  it('retries once with the new token after a 401 on an authenticated request', async () => {
    const base = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok());
    const refresh = vi.fn(async () => session('new'));
    const response = await withTokenRetry(base, { refresh })('http://api/v1/products', authed);
    expect(response.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    expect((base.mock.calls[1]![1]!.headers as Record<string, string>).authorization).toBe(
      'Bearer new',
    );
  });

  it('never retries sign-in style endpoints (a 401 there means wrong password)', async () => {
    for (const path of ['login', 'register', 'refresh', 'accept-invitation']) {
      const base = vi.fn<typeof fetch>().mockResolvedValue(unauthorized());
      const refresh = vi.fn(async () => session('new'));
      const response = await withTokenRetry(base, { refresh })(
        `http://api/v1/auth/${path}`,
        authed,
      );
      expect(response.status).toBe(401);
      expect(refresh).not.toHaveBeenCalled();
    }
  });

  it('does not retry requests that carried no token, or when the refresh fails', async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(unauthorized());
    const refresh = vi.fn(async () => session('new'));
    expect((await withTokenRetry(base, { refresh })('http://api/v1/health')).status).toBe(401);
    expect(refresh).not.toHaveBeenCalled();

    const failing = vi.fn(async () => Promise.reject(reject(401)));
    expect(
      (await withTokenRetry(base, { refresh: failing })('http://api/v1/products', authed)).status,
    ).toBe(401);
    expect(base).toHaveBeenCalledTimes(2); // the original calls only, no retry
  });

  it('passes other statuses straight through', async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 409 }));
    expect(
      (await withTokenRetry(base, { refresh: vi.fn() })('http://api/v1/products', authed)).status,
    ).toBe(409);
    expect(base).toHaveBeenCalledTimes(1);
  });
});
