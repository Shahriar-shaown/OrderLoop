import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (s: { isConnected?: boolean; isInternetReachable?: boolean }) => void;
let osListener: Listener = () => undefined;
let initial: { isConnected?: boolean } = { isConnected: true };
let serverUp = true;
const probes: string[] = [];

vi.mock('expo-network', () => ({
  getNetworkStateAsync: async () => initial,
  addNetworkStateListener: (l: Listener) => {
    osListener = l;
    return { remove: () => undefined };
  },
}));
vi.mock('./env', () => ({ env: { API_URL: 'http://api.test' } }));
// The store itself is plain TypeScript; load it without the screens (they need react-native).
vi.mock(
  '@orderloop/features',
  async () => import('../../../../packages/features/src/connectivity'),
);

const load = async () => {
  vi.resetModules();
  return (await import('./connectivity')).connectivity;
};
const settle = () => vi.advanceTimersByTimeAsync(50);

beforeEach(() => {
  vi.useFakeTimers();
  serverUp = true;
  initial = { isConnected: true };
  probes.length = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    probes.push(url);
    if (!serverUp) throw new TypeError('Network request failed');
    return { ok: true } as Response;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('device connectivity', () => {
  it('is online when the operating system says there is a network, without asking the server', async () => {
    const c = await load();
    await settle();
    expect(c.isOnline()).toBe(true);
    expect(probes).toEqual([]);
  });

  it('believes "no network" only when our own server cannot be reached either', async () => {
    const c = await load();
    await settle();
    serverUp = false;
    osListener({ isConnected: false });
    await settle();
    expect(c.isOnline()).toBe(false);
    expect(probes[0]).toBe('http://api.test/health/live');
  });

  it('stays online when the OS is wrong (an emulator, a captive portal) but the server answers', async () => {
    const c = await load();
    osListener({ isConnected: false });
    await settle();
    expect(c.isOnline()).toBe(true);
  });

  it('notices recovery by itself while offline, without waiting for an OS event', async () => {
    const c = await load();
    serverUp = false;
    osListener({ isConnected: false });
    await settle();
    expect(c.isOnline()).toBe(false);
    serverUp = true;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(c.isOnline()).toBe(true);
  });

  it('checks the server when a request got no answer, and goes offline if it is gone', async () => {
    const c = await load();
    await settle();
    serverUp = false;
    c.reportFailure?.();
    await settle();
    expect(c.isOnline()).toBe(false);
  });
});
