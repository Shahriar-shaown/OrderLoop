import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
let deviceLanguage: string | null = 'en';
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => storage.get(k) ?? null,
    setItem: async (k: string, v: string) => void storage.set(k, v),
  },
}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: deviceLanguage }] }));

beforeEach(() => {
  storage.clear();
  deviceLanguage = 'en';
});

describe('language on the device', () => {
  it('remembers the choice and gives it back', async () => {
    const { localeStore } = await import('./localeStore');
    expect(await localeStore.get()).toBeNull();
    await localeStore.set('bn');
    expect(await localeStore.get()).toBe('bn');
    expect([...storage.keys()]).toEqual(['orderloop.language']);
  });

  it('ignores a stored value it does not know', async () => {
    const { localeStore } = await import('./localeStore');
    storage.set('orderloop.language', 'fr');
    expect(await localeStore.get()).toBeNull();
  });

  it('starts in Bangla on a phone set to Bangla, in English otherwise', async () => {
    const { deviceLocale } = await import('./localeStore');
    expect(deviceLocale()).toBe('en');
    deviceLanguage = 'bn';
    expect(deviceLocale()).toBe('bn');
    deviceLanguage = 'hi';
    expect(deviceLocale()).toBe('en');
  });
});
