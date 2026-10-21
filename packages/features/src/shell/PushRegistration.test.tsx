import { ApiError } from '@orderloop/api-client';
import type { Notification } from '@orderloop/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mount, session } from '../../test/mount';
import { NotificationBell } from '../components/notifications/NotificationBell';
import { useAuth } from '../core/auth';
import { PushRegistrar, type PushMessage, type PushPlatform } from '../core/push';
import { SessionManager } from '../core/session';

const uuid = (n: number) => `0197b0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TOKEN = 'ExponentPushToken[abc123]';

/** A phone whose push events the test can fire. */
function phone() {
  const received = new Set<(m: PushMessage) => void>();
  const opened = new Set<(m: PushMessage) => void>();
  const tokenChanged = new Set<() => void>();
  const current = { token: TOKEN };
  const platform: PushPlatform = {
    supported: true,
    permission: vi.fn(async () => 'granted' as const),
    requestPermission: vi.fn(async () => 'granted' as const),
    token: vi.fn(async () => ({ token: current.token, platform: 'android' as const })),
    onTokenChange: (l) => {
      const wrapped = () => l({ token: current.token, platform: 'android' });
      tokenChanged.add(wrapped);
      return () => tokenChanged.delete(wrapped);
    },
    onReceived: (l) => {
      received.add(l);
      return () => received.delete(l);
    },
    onOpened: (l) => {
      opened.add(l);
      return () => opened.delete(l);
    },
  };
  return {
    platform,
    receive: (m: PushMessage) => received.forEach((l) => l(m)),
    tap: (m: PushMessage) => opened.forEach((l) => l(m)),
    changeToken: (token: string) => {
      current.token = token;
      tokenChanged.forEach((l) => l());
    },
  };
}

const lowStock = (over: Partial<Notification> = {}): Notification => ({
  id: uuid(1),
  kind: 'LOW_STOCK',
  title: 'Low stock: 1 item',
  body: 'x',
  data: { kind: 'LOW_STOCK', count: 1 },
  createdAt: new Date().toISOString(),
  readAt: new Date().toISOString(),
  ...over,
});

function setup(markRead: (id: string) => Promise<Notification> = async () => lowStock()) {
  const device = phone();
  const calls: string[] = [];
  const api = {
    pushDevices: {
      register: vi.fn(async () => {
        calls.push('register');
        return {};
      }),
      remove: vi.fn(async () => {
        calls.push('remove');
        return {};
      }),
    },
    notifications: {
      markRead: vi.fn(markRead),
      unreadCount: vi.fn(async () => ({ count: 0 })),
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
    },
  };
  const push = new PushRegistrar(device.platform, api as never);
  return { device, api, push, calls };
}

function SignOut() {
  const { signOut, status } = useAuth();
  return (
    <button
      disabled={status !== 'authenticated'}
      onClick={() => void signOut().catch(() => undefined)}
    >
      sign out now
    </button>
  );
}

describe('push on the phone while signed in', () => {
  it('registers the phone after sign-in, and again when its token changes', async () => {
    const { device, api, push } = setup();
    mount(<div />, api, 'OWNER', { push });
    await waitFor(() => expect(api.pushDevices.register).toHaveBeenCalledTimes(1));
    expect(api.pushDevices.register).toHaveBeenCalledWith({ token: TOKEN, platform: 'android' });
    device.changeToken('ExponentPushToken[renewed9]');
    await waitFor(() => expect(api.pushDevices.register).toHaveBeenCalledTimes(2));
    expect(api.pushDevices.register).toHaveBeenLastCalledWith({
      token: 'ExponentPushToken[renewed9]',
      platform: 'android',
    });
  });

  it('does nothing on the web, where the runtime has no push', async () => {
    const { api } = setup();
    mount(<div>web</div>, api);
    await screen.findByText('web');
    expect(api.pushDevices.register).not.toHaveBeenCalled();
  });

  it('shows a push that arrives while the app is open, and refreshes the bell', async () => {
    const { device, api, push } = setup();
    mount(<NotificationBell />, api, 'OWNER', { push });
    await waitFor(() => expect(api.pushDevices.register).toHaveBeenCalled());
    await waitFor(() => expect(api.notifications.unreadCount).toHaveBeenCalledTimes(1));
    device.receive({ kind: 'LOW_STOCK', id: uuid(1) });
    expect(await screen.findByText('New notification: Low stock')).toBeTruthy();
    await waitFor(() => expect(api.notifications.unreadCount).toHaveBeenCalledTimes(2));
  });

  it('opens the right screen when a push is tapped: reads the notification, then goes where it leads', async () => {
    const { device, api, push } = setup(async () =>
      lowStock({ kind: 'NEW_ORDER', data: { kind: 'NEW_ORDER', count: 1, orderIds: [uuid(9)] } }),
    );
    const { navigation } = mount(<div />, api, 'OWNER', { push });
    await waitFor(() => expect(api.pushDevices.register).toHaveBeenCalled());
    device.tap({ kind: 'NEW_ORDER', id: uuid(1) });
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith(`/orders/${uuid(9)}`));
    expect(api.notifications.markRead).toHaveBeenCalledWith(uuid(1));
  });

  it('keeps a tap that arrives before the person is signed in, and acts on it once they are', async () => {
    const { device, api, push } = setup();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const manager = new SessionManager({
      refresh: async () => {
        await gate;
        return session('OWNER');
      },
      logout: async () => undefined,
    });
    const { navigation } = mount(<div />, api, 'OWNER', { push, session: manager });
    device.tap({ kind: 'LOW_STOCK', id: uuid(1) }); // the app was opened from the notification, session not restored yet
    await Promise.resolve();
    expect(api.notifications.markRead).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/products?tab=low'));
    expect(api.notifications.markRead).toHaveBeenCalledTimes(1);
  });

  it('opens the notifications list when the tapped one cannot be read', async () => {
    const { device, api, push } = setup(async () => {
      throw new Error('gone');
    });
    const { navigation } = mount(<div />, api, 'OWNER', { push });
    await waitFor(() => expect(api.pushDevices.register).toHaveBeenCalled());
    device.tap({ kind: 'LOW_STOCK', id: uuid(1) });
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/notifications'));
  });
});

describe('signing out', () => {
  function withManager(logout: () => Promise<unknown>, calls: string[]) {
    return new SessionManager({
      refresh: async () => session('OWNER'),
      logout: async () => {
        calls.push('logout');
        return logout();
      },
    });
  }

  it('makes the server forget the phone before the session ends', async () => {
    const { api, push, calls } = setup();
    const manager = withManager(async () => undefined, calls);
    mount(<SignOut />, api, 'OWNER', { push, session: manager });
    await waitFor(() => expect(api.pushDevices.register).toHaveBeenCalled());
    await userEvent.click(await screen.findByRole('button', { name: 'sign out now' }));
    await waitFor(() => expect(calls).toEqual(['register', 'remove', 'logout']));
  });

  it('still signs out when the phone cannot be forgotten (best effort)', async () => {
    const { api, push, calls } = setup();
    api.pushDevices.remove.mockRejectedValueOnce(new Error('offline'));
    mount(<SignOut />, api, 'OWNER', { push, session: withManager(async () => undefined, calls) });
    await waitFor(() => expect(api.pushDevices.register).toHaveBeenCalled());
    await userEvent.click(await screen.findByRole('button', { name: 'sign out now' }));
    await waitFor(() => expect(calls).toContain('logout'));
  });

  it('registers the phone again when signing out fails and the person stays signed in', async () => {
    const { api, push, calls } = setup();
    const manager = withManager(async () => {
      throw new ApiError('no connection', undefined, 'network_error');
    }, calls);
    mount(<SignOut />, api, 'OWNER', { push, session: manager });
    await waitFor(() => expect(api.pushDevices.register).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: 'sign out now' }));
    await waitFor(() => expect(api.pushDevices.register).toHaveBeenCalledTimes(2));
    expect(calls.slice(0, 3)).toEqual(['register', 'remove', 'logout']);
  });

  it('works the same without push (the web)', async () => {
    const { api, calls } = setup();
    mount(<SignOut />, api, 'OWNER', { session: withManager(async () => undefined, calls) });
    await userEvent.click(await screen.findByRole('button', { name: 'sign out now' }));
    await waitFor(() => expect(calls).toEqual(['logout']));
  });
});
