import { ApiError } from '@orderloop/api-client';
import type { AuthResult } from '@orderloop/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  SIGN_OUT_FAILED,
  TENANT_CHANGED_MESSAGE,
  SessionManager,
  isAuthRejection,
  withTokenRetry,
} from './session';

const session = (token: string, expiresIn = 900): AuthResult =>
  ({
    accessToken: token,
    expiresIn,
    user: { id: 'u', email: 'a@b.c', name: 'A', emailVerified: true, language: 'en' },
    tenant: {
      id: 't',
      name: 'T',
      logoUrl: null,
      currency: 'BDT',
      timezone: 'Asia/Dhaka',
      defaultLanguage: 'en',
    },
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

  it('start adopts a session; logout clears it locally even if the server call fails oddly', async () => {
    const { manager, logout } = setup();
    manager.start(session('signed-in'));
    expect(manager.getAccessToken()).toBe('signed-in');
    logout.mockRejectedValueOnce(new Error('boom'));
    await manager.logout();
    expect(manager.getSnapshot()).toEqual({ status: 'anonymous', session: null });
    manager.dispose();
  });

  it('logout clears locally when the server answers, even with an error (the session is gone)', async () => {
    const { manager, logout } = setup();
    manager.start(session('signed-in'));
    logout.mockRejectedValueOnce(new ApiError('Unauthorized', 401, 'unauthorized'));
    await manager.logout();
    expect(manager.getSnapshot().status).toBe('anonymous');
    manager.dispose();
  });

  it('logout refuses, and keeps the session, when the server cannot be reached', async () => {
    for (const code of ['offline', 'network_error', 'request_timeout']) {
      const persisted: (string | null)[] = [];
      const logout = vi.fn(async () => Promise.reject(new ApiError('no route', undefined, code)));
      const manager = new SessionManager({
        refresh: async () => session('x'),
        logout,
        persist: (s) => void persisted.push(s?.accessToken ?? null),
      });
      manager.start(session('signed-in'));
      await expect(manager.logout()).rejects.toThrow(SIGN_OUT_FAILED);
      expect(manager.getSnapshot().status).toBe('authenticated');
      expect(persisted).toEqual(['signed-in']);
      manager.dispose();
    }
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

describe('persisting the session (native apps)', () => {
  it('hands every adopted session, and the sign-out, to the persist hook', async () => {
    const persisted: (string | null)[] = [];
    const manager = new SessionManager({
      refresh: async () => session('refreshed'),
      logout: async () => undefined,
      persist: (s) => void persisted.push(s?.accessToken ?? null),
    });
    manager.start(session('first'));
    await manager.refresh();
    await manager.logout();
    expect(persisted).toEqual(['first', 'refreshed', null]);
    manager.dispose();
  });

  it('keeps working when storage throws', async () => {
    const manager = new SessionManager({
      refresh: async () => session('x'),
      logout: async () => undefined,
      persist: () => {
        throw new Error('keychain unavailable');
      },
    });
    manager.start(session('ok'));
    expect(manager.getSnapshot().status).toBe('authenticated');
    manager.dispose();
  });
});

describe('SessionManager: why a session ended', () => {
  it('says "expired" when the server stops accepting a session that was running', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(session('first'))
      .mockRejectedValueOnce(reject(401));
    const { manager } = setup(refresh);
    await manager.init();
    expect(manager.getSnapshot().endedBy).toBeUndefined();
    await manager.refresh();
    expect(manager.getSnapshot()).toMatchObject({
      status: 'anonymous',
      session: null,
      endedBy: 'expired',
    });
  });

  it('says nothing special when there was no session to restore, or the person signed out', async () => {
    const none = setup(vi.fn(async () => Promise.reject(reject(401))));
    await none.manager.init();
    expect(none.manager.getSnapshot()).toEqual({ status: 'anonymous', session: null });
    const out = setup();
    await out.manager.init();
    await out.manager.logout();
    expect(out.manager.getSnapshot().endedBy).toBeUndefined();
  });

  it('keeps the session when the refresh fails for lack of a connection (nobody is signed out by a bad signal)', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(session('first'))
      .mockRejectedValueOnce(new TypeError('offline'));
    const { manager } = setup(refresh);
    await manager.init();
    await expect(manager.refresh()).rejects.toThrow('offline');
    expect(manager.getSnapshot().status).toBe('authenticated');
  });
});

describe('SessionManager: a refresh that was in flight when the person signed out', () => {
  it('does not bring the session back', async () => {
    let finish!: (s: AuthResult) => void;
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(session('first'))
      .mockImplementationOnce(() => new Promise<AuthResult>((resolve) => (finish = resolve)));
    const { manager } = setup(refresh);
    await manager.init();
    const pending = manager.refresh();
    await manager.logout();
    finish(session('late'));
    await pending;
    expect(manager.getSnapshot()).toMatchObject({ status: 'anonymous', session: null });
  });
});

describe('withTokenRetry', () => {
  it('retries with the new token and a fresh timeout, not the first attempt’s spent one', async () => {
    const spent = AbortSignal.abort();
    const base = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const manager = { refresh: vi.fn(async () => session('new')) };
    const guarded = withTokenRetry(base as unknown as typeof fetch, manager);
    await guarded('http://x/v1/orders', {
      headers: { authorization: 'Bearer old' },
      signal: spent,
    });
    const retry = base.mock.calls[1]![1] as RequestInit;
    expect((retry.headers as Record<string, string>).authorization).toBe('Bearer new');
    expect(retry.signal?.aborted).toBe(false);
  });
});

describe('withTokenRetry: the retried request gets the wait its kind deserves', () => {
  it('a retried write waits 30 s, a retried read 10 s', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      for (const method of ['POST', 'GET']) {
        const base = vi
          .fn()
          .mockResolvedValueOnce(new Response('', { status: 401 }))
          .mockResolvedValueOnce(new Response('{}', { status: 200 }));
        const guarded = withTokenRetry(base as unknown as typeof fetch, {
          refresh: async () => session('new'),
        });
        await guarded('http://x/v1/orders', {
          method,
          headers: { authorization: 'Bearer old' },
          signal: AbortSignal.abort(),
        });
      }
      expect(spy.mock.calls.map((c) => c[0])).toEqual([30_000, 10_000]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('SessionManager: a slow start-up restore that is refused after the person signed in', () => {
  it('does not sign the new session out', async () => {
    let refuse!: (e: unknown) => void;
    const refresh = vi.fn(() => new Promise<AuthResult>((_, reject) => (refuse = reject)));
    const { manager } = setup(refresh);
    const restoring = manager.init().catch(() => undefined);
    manager.start(session('signed-in')); // the person signs in while the restore is still waiting
    refuse(reject(401));
    await restoring;
    expect(manager.getSnapshot()).toMatchObject({ status: 'authenticated' });
    expect(manager.getAccessToken()).toBe('signed-in');
  });
});

describe('SessionManager: the business another tab switched to', () => {
  it('sends the business it is in once the session is known, and none before', async () => {
    const { manager, refresh } = setup();
    await manager.init();
    expect(refresh).toHaveBeenLastCalledWith(undefined);
    await manager.refresh();
    expect(refresh).toHaveBeenLastCalledWith('t');
    manager.dispose();
  });

  it('ends the session with a clear reason instead of adopting the other business', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(session('first'))
      .mockRejectedValueOnce(new ApiError('Tenant changed', 409, 'tenant_changed'));
    const { manager, logout } = setup(refresh);
    await manager.init();
    expect(await manager.refresh()).toBeNull();
    expect(manager.getSnapshot()).toEqual({
      status: 'anonymous',
      session: null,
      endedBy: 'tenant_changed',
    });
    expect(logout).not.toHaveBeenCalled(); // the shared session belongs to the other tab
    expect(TENANT_CHANGED_MESSAGE).toMatch(/Reload to continue in that business/);
    manager.dispose();
  });
});
