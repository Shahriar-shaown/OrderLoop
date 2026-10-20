import type { AuthResult } from '@orderloop/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime, type RefreshTokenStore } from './runtime';

const result = (accessToken: string, refreshToken?: string): AuthResult => ({
  accessToken,
  expiresIn: 900,
  ...(refreshToken ? { refreshToken } : {}),
  user: {
    id: '0197b0a0-0000-7000-8000-000000000001',
    email: 'a@b.test',
    name: 'Anwar',
    emailVerified: true,
    language: 'en',
  },
  tenant: {
    id: '0197b0a0-0000-7000-8000-000000000002',
    name: 'Shop',
    logoUrl: null,
    currency: 'BDT',
    timezone: 'Asia/Dhaka',
    defaultLanguage: 'en',
  },
  role: 'OWNER',
  memberships: [],
});

function memoryStore(initial: string | null): RefreshTokenStore & { value: string | null } {
  const store = {
    value: initial,
    get: async () => store.value,
    set: async (token: string | null) => void (store.value = token),
  };
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe('native runtime (refresh token in device storage)', () => {
  it('restores the session by sending the stored refresh token and stores the rotated one', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(result('access-2', 'rt-2')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const store = memoryStore('rt-1');
    const runtime = createRuntime({ baseUrl: 'http://api.test', refreshTokenStore: store });
    const restored = await runtime.session.init();
    expect(restored?.accessToken).toBe('access-2');
    expect(bodies).toEqual([{ refreshToken: 'rt-1' }]);
    await vi.waitFor(() => expect(store.value).toBe('rt-2'));
    runtime.session.dispose();
  });

  it('is anonymous, without calling the API, when nothing is stored', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const runtime = createRuntime({
      baseUrl: 'http://api.test',
      refreshTokenStore: memoryStore(null),
    });
    expect(await runtime.session.init()).toBeNull();
    expect(runtime.session.getSnapshot().status).toBe('anonymous');
    expect(fetchSpy).not.toHaveBeenCalled();
    runtime.session.dispose();
  });

  it('forgets the stored token on sign-out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const store = memoryStore('rt-1');
    const runtime = createRuntime({ baseUrl: 'http://api.test', refreshTokenStore: store });
    runtime.session.start(result('a', 'rt-9'));
    await vi.waitFor(() => expect(store.value).toBe('rt-9'));
    await runtime.session.logout();
    await vi.waitFor(() => expect(store.value).toBeNull());
    runtime.session.dispose();
  });
});
