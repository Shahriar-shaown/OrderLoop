import { afterEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const plain = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => plain.get(k) ?? null,
    setItem: async (k: string, v: string) => void plain.set(k, v),
  },
}));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void store.set(key, value),
  deleteItemAsync: async (key: string) => void store.delete(key),
}));

afterEach(() => {
  store.clear();
  plain.clear();
});

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

  it('forgets a token left behind by an earlier install (the keychain outlives an uninstall)', async () => {
    const { secureTokenStore } = await import('./secureTokenStore');
    store.set('orderloop.refresh-token', 'stale'); // no install marker: a fresh install
    expect(await secureTokenStore.get()).toBeNull();
    await secureTokenStore.set('fresh');
    expect(await secureTokenStore.get()).toBe('fresh'); // the marker is now set: it is kept
  });

  it('keeps a token stored by the first-ever sign-in across a cold start', async () => {
    const { secureTokenStore } = await import('./secureTokenStore');
    await secureTokenStore.set('first'); // no get() before it: the marker was never written by a read
    vi.resetModules(); // a cold start: nothing in memory, only what the storage holds
    const fresh = await import('./secureTokenStore');
    expect(await fresh.secureTokenStore.get()).toBe('first');
  });
});
