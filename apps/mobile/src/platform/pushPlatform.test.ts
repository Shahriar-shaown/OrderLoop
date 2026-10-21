import { describe, expect, it, vi } from 'vitest';
import { createPushPlatform, parseMessage, type PushSystem } from './pushPlatform';

function fakeSystem(over: Partial<PushSystem> = {}) {
  const listeners = {
    token: new Set<() => void>(),
    received: new Set<(data: unknown) => void>(),
    tapped: new Set<(data: unknown) => void>(),
  };
  const calls: string[] = [];
  let launchTap: unknown = null;
  const system: PushSystem = {
    os: 'android',
    isDevice: true,
    isExpoGo: false,
    projectId: 'project-1',
    getPermission: vi.fn(async () => ({ status: 'granted' as const, canAskAgain: true })),
    requestPermission: vi.fn(async () => {
      calls.push('ask');
      return { status: 'granted' as const, canAskAgain: true };
    }),
    ensureChannel: vi.fn(async () => void calls.push('channel')),
    getExpoToken: vi.fn(async (project: string) => `ExponentPushToken[${project}]`),
    quietForeground: vi.fn(),
    onDeviceTokenChange: (l) => {
      listeners.token.add(l);
      return () => listeners.token.delete(l);
    },
    onReceived: (l) => {
      listeners.received.add(l);
      return () => listeners.received.delete(l);
    },
    onTapped: (l) => {
      listeners.tapped.add(l);
      return () => listeners.tapped.delete(l);
    },
    takeLaunchTap: vi.fn(async () => {
      const tap = launchTap;
      launchTap = null;
      return tap;
    }),
    log: vi.fn(),
    ...over,
  };
  return {
    system,
    listeners,
    calls,
    setLaunchTap: (tap: unknown) => (launchTap = tap),
  };
}

describe('what a push carries', () => {
  it('is the kind and the id of the notification, nothing else is trusted', () => {
    expect(parseMessage({ kind: 'LOW_STOCK', id: 'abc', extra: 1 })).toEqual({
      kind: 'LOW_STOCK',
      id: 'abc',
    });
    for (const bad of [
      null,
      undefined,
      'x',
      3,
      {},
      { kind: 'LOW_STOCK' },
      { kind: 1, id: 'a' },
      { kind: 'A', id: '' },
    ])
      expect(parseMessage(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('push on a phone that cannot do it', () => {
  it.each([
    ['a simulator', { isDevice: false }],
    ['Expo Go', { isExpoGo: true }],
    ['a build made before the notification module was added', { nativeModulesMissing: true }],
    ['a build with no project id', { projectId: undefined }],
    ['the web', { os: 'web' }],
  ])(
    'stays silent on %s: nothing is asked, listened to or fetched, and the log says why once',
    async (_n, over) => {
      const { system } = fakeSystem(over);
      const push = createPushPlatform(system);
      expect(push.supported).toBe(false);
      expect(await push.permission()).toBe('denied');
      expect(await push.requestPermission()).toBe('denied');
      expect(await push.token()).toBeNull();
      push.onTokenChange(() => undefined)();
      push.onReceived(() => undefined)();
      push.onOpened(() => undefined)();
      expect(system.getPermission).not.toHaveBeenCalled();
      expect(system.requestPermission).not.toHaveBeenCalled();
      expect(system.getExpoToken).not.toHaveBeenCalled();
      expect(system.takeLaunchTap).not.toHaveBeenCalled();
      expect(system.quietForeground).not.toHaveBeenCalled();
      expect(system.log).toHaveBeenCalledTimes(1);
    },
  );
});

describe('push on a phone', () => {
  it('keeps pushes out of the system banner while the app is open', () => {
    const { system } = fakeSystem();
    createPushPlatform(system);
    expect(system.quietForeground).toHaveBeenCalledTimes(1);
  });

  it('reports what the person allowed, and treats "denied but can still ask" as undecided', async () => {
    const answers = [
      [{ status: 'granted', canAskAgain: true }, 'granted'],
      [{ status: 'undetermined', canAskAgain: true }, 'undetermined'],
      [{ status: 'denied', canAskAgain: true }, 'undetermined'],
      [{ status: 'denied', canAskAgain: false }, 'denied'],
    ] as const;
    for (const [answer, expected] of answers) {
      const { system } = fakeSystem({ getPermission: async () => answer });
      expect(await createPushPlatform(system).permission(), JSON.stringify(answer)).toBe(expected);
    }
  });

  it('prepares the Android channel before it asks, and asks only when told to', async () => {
    const { system, calls } = fakeSystem();
    const push = createPushPlatform(system);
    await push.permission();
    await push.token();
    expect(system.requestPermission).not.toHaveBeenCalled();
    calls.length = 0;
    await push.requestPermission();
    expect(calls).toEqual(['channel', 'ask']);
  });

  it('gives the Expo push token of the project with the phone’s platform', async () => {
    for (const os of ['android', 'ios'] as const) {
      const { system } = fakeSystem({ os });
      expect(await createPushPlatform(system).token()).toEqual({
        token: 'ExponentPushToken[project-1]',
        platform: os,
      });
    }
  });

  it('has no token, and says so once, when the push service refuses', async () => {
    const { system } = fakeSystem({
      getExpoToken: async () => {
        throw new Error('service unavailable');
      },
    });
    const push = createPushPlatform(system);
    expect(await push.token()).toBeNull();
    expect(await push.token()).toBeNull();
    expect(system.log).toHaveBeenCalledTimes(1);
  });

  it('hands over the new token when the device token changes, and stops listening when asked', async () => {
    const { system, listeners } = fakeSystem();
    const push = createPushPlatform(system);
    const seen: string[] = [];
    const stop = push.onTokenChange((t) => seen.push(t.token));
    listeners.token.forEach((l) => l());
    await vi.waitFor(() => expect(seen).toEqual(['ExponentPushToken[project-1]']));
    stop();
    expect(listeners.token.size).toBe(0);
  });

  it('passes on a push that arrives in the foreground, ignoring one that is not ours', () => {
    const { system, listeners } = fakeSystem();
    const seen: unknown[] = [];
    createPushPlatform(system).onReceived((m) => seen.push(m));
    listeners.received.forEach((l) => l({ kind: 'NEW_ORDER', id: 'n1' }));
    listeners.received.forEach((l) => l({ unrelated: true }));
    expect(seen).toEqual([{ kind: 'NEW_ORDER', id: 'n1' }]);
  });

  it('passes on a tap, and the tap that opened the app exactly once', async () => {
    const { system, listeners, setLaunchTap } = fakeSystem();
    setLaunchTap({ kind: 'LOW_STOCK', id: 'n9' });
    const push = createPushPlatform(system);
    const first: unknown[] = [];
    push.onOpened((m) => first.push(m));
    await vi.waitFor(() => expect(first).toEqual([{ kind: 'LOW_STOCK', id: 'n9' }]));
    listeners.tapped.forEach((l) => l({ kind: 'NEW_ORDER', id: 'n2' }));
    expect(first).toHaveLength(2);
    // Listening again later (a remount) does not replay the launch tap.
    const second: unknown[] = [];
    push.onOpened((m) => second.push(m));
    await Promise.resolve();
    await Promise.resolve();
    expect(second).toEqual([]);
  });
});
