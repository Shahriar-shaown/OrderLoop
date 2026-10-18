import { afterEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void store.set(key, value),
  deleteItemAsync: async (key: string) => void store.delete(key),
}));

afterEach(() => store.clear());

describe('mobile refresh-token storage', () => {
  it('reads nothing before sign-in, stores the token, and forgets it on sign-out', async () => {
    const { secureTokenStore } = await import('./secureTokenStore');
    expect(await secureTokenStore.get()).toBeNull();
    await secureTokenStore.set('rt-1');
    expect(await secureTokenStore.get()).toBe('rt-1');
    await secureTokenStore.set('rt-2'); // rotation replaces it
    expect([...store.values()]).toEqual(['rt-2']);
    await secureTokenStore.set(null);
    expect(store.size).toBe(0);
  });

  it('uses a single, namespaced key', async () => {
    const { secureTokenStore } = await import('./secureTokenStore');
    await secureTokenStore.set('x');
    expect([...store.keys()]).toEqual(['orderloop.refresh-token']);
  });
});
