import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushRegistrar, type PushPermission, type PushPlatform, type PushToken } from './push';

const TOKEN: PushToken = { token: 'ExponentPushToken[abc123]', platform: 'android' };

function fakePlatform(
  over: Partial<{ supported: boolean; permission: PushPermission; token: PushToken | null }> = {},
) {
  const state = {
    permission: 'granted' as PushPermission,
    token: TOKEN as PushToken | null,
    ...over,
  };
  const platform: PushPlatform & { state: typeof state } = {
    state,
    supported: over.supported ?? true,
    permission: vi.fn(async () => state.permission),
    requestPermission: vi.fn(async () => {
      if (state.permission === 'undetermined') state.permission = 'granted';
      return state.permission;
    }),
    token: vi.fn(async () => state.token),
    onTokenChange: () => () => undefined,
    onReceived: () => () => undefined,
    onOpened: () => () => undefined,
  };
  return platform;
}

function fakeApi(
  over: { register?: () => Promise<unknown>; remove?: () => Promise<unknown> } = {},
) {
  return {
    pushDevices: {
      register: vi.fn<(body?: unknown) => Promise<unknown>>(over.register ?? (async () => ({}))),
      remove: vi.fn(over.remove ?? (async () => ({}))),
    },
  };
}
const make = (platform: PushPlatform, api = fakeApi()) => {
  const warn = vi.fn();
  return { registrar: new PushRegistrar(platform, api as never, warn), api, warn };
};

afterEach(() => vi.useRealTimers());

describe('registering this phone for push', () => {
  it('registers the token once it has been allowed, and only once per token', async () => {
    const { registrar, api } = make(fakePlatform());
    expect(await registrar.sync()).toBe(TOKEN.token);
    await registrar.sync();
    expect(api.pushDevices.register).toHaveBeenCalledTimes(1);
    expect(api.pushDevices.register).toHaveBeenCalledWith({
      token: TOKEN.token,
      platform: 'android',
    });
  });

  it('registers again when the push service issues a new token', async () => {
    const platform = fakePlatform();
    const { registrar, api } = make(platform);
    await registrar.sync();
    platform.state.token = { token: 'ExponentPushToken[new999]', platform: 'android' };
    await registrar.sync();
    expect(api.pushDevices.register.mock.calls.map((c) => (c[0] as PushToken).token)).toEqual([
      'ExponentPushToken[abc123]',
      'ExponentPushToken[new999]',
    ]);
  });

  it('never prompts and registers nothing until the person has allowed notifications', async () => {
    for (const permission of ['undetermined', 'denied'] as const) {
      const platform = fakePlatform({ permission });
      const { registrar, api } = make(platform);
      expect(await registrar.sync()).toBeNull();
      expect(platform.requestPermission).not.toHaveBeenCalled();
      expect(api.pushDevices.register).not.toHaveBeenCalled();
    }
  });

  it('does nothing on a phone that cannot do push, or that has no token', async () => {
    const unsupported = make(fakePlatform({ supported: false }));
    expect(await unsupported.registrar.sync()).toBeNull();
    await unsupported.registrar.unregister();
    expect(unsupported.api.pushDevices.register).not.toHaveBeenCalled();
    expect(unsupported.api.pushDevices.remove).not.toHaveBeenCalled();
    const noToken = make(fakePlatform({ token: null }));
    expect(await noToken.registrar.sync()).toBeNull();
    expect(noToken.api.pushDevices.register).not.toHaveBeenCalled();
  });

  it('asks only when told to, then registers if the answer is yes', async () => {
    const platform = fakePlatform({ permission: 'undetermined' });
    const { registrar, api } = make(platform);
    expect(await registrar.enable()).toBe('granted');
    expect(platform.requestPermission).toHaveBeenCalledTimes(1);
    expect(api.pushDevices.register).toHaveBeenCalledTimes(1);

    const refused = fakePlatform({ permission: 'denied' });
    const second = make(refused);
    expect(await second.registrar.enable()).toBe('denied');
    expect(second.api.pushDevices.register).not.toHaveBeenCalled();
  });

  it('survives a failed registration (it is tried again next time) and says so once in the log', async () => {
    let fail = true;
    const { registrar, api, warn } = make(
      fakePlatform(),
      fakeApi({ register: async () => (fail ? Promise.reject(new Error('offline')) : {}) }),
    );
    expect(await registrar.sync()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    fail = false;
    expect(await registrar.sync()).toBe(TOKEN.token);
    expect(api.pushDevices.register).toHaveBeenCalledTimes(2);
  });
});

describe('forgetting this phone before signing out', () => {
  it('removes the token it registered', async () => {
    const { registrar, api } = make(fakePlatform());
    await registrar.sync();
    await registrar.unregister();
    expect(api.pushDevices.remove).toHaveBeenCalledWith(TOKEN.token);
    // Signed in again later: the same token is registered afresh.
    await registrar.sync();
    expect(api.pushDevices.register).toHaveBeenCalledTimes(2);
  });

  it('finds the token itself when nothing was registered in this run (the app was restarted)', async () => {
    const { registrar, api } = make(fakePlatform());
    await registrar.unregister();
    expect(api.pushDevices.remove).toHaveBeenCalledWith(TOKEN.token);
  });

  it('never throws and never waits long: a failing or silent server does not hold sign-out up', async () => {
    const failing = make(
      fakePlatform(),
      fakeApi({ remove: () => Promise.reject(new Error('offline')) }),
    );
    await expect(failing.registrar.unregister()).resolves.toBeUndefined();
    expect(failing.warn).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    const silent = make(fakePlatform(), fakeApi({ remove: () => new Promise(() => undefined) }));
    const done = silent.registrar.unregister();
    await vi.advanceTimersByTimeAsync(3100);
    await expect(done).resolves.toBeUndefined();
    expect(silent.warn).toHaveBeenCalledTimes(1);
  });

  it('has nothing to remove when notifications were never allowed', async () => {
    const { registrar, api } = make(fakePlatform({ permission: 'undetermined' }));
    await registrar.unregister();
    expect(api.pushDevices.remove).not.toHaveBeenCalled();
  });
});
