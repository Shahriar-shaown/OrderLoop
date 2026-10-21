import { ApiError } from '@orderloop/api-client';
import type { Notification, NotificationPreference } from '@orderloop/contracts';
import { onlineManager } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../../test/mount';
import { NotificationBell } from '../../components/notifications/NotificationBell';
import { createConnectivityStore } from '../../core/connectivity';
import type { PushPermission, PushPlatform } from '../../core/push';
import { PushRegistrar } from '../../core/push';
import { NotificationPreferencesScreen } from './NotificationPreferencesScreen';
import { NotificationsScreen } from './NotificationsScreen';

const uuid = (n: number) => `0197b0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date().toISOString();

const note = (n: number, over: Partial<Notification> = {}): Notification => ({
  id: uuid(n),
  kind: 'LOW_STOCK',
  title: 'Low stock: 2 items',
  body: 'Glass vase (VASE-1): 1 left; Desk lamp (LAMP-1): 0 left.',
  data: { kind: 'LOW_STOCK', count: 2, variantIds: [uuid(90), uuid(91)] },
  createdAt: NOW,
  readAt: null,
  ...over,
});
const unreadLowStock = note(1);
const readOrder = note(2, {
  kind: 'NEW_ORDER',
  title: 'New order #1042',
  body: 'Order #1042 came in.',
  data: { kind: 'NEW_ORDER', count: 1, orderIds: [uuid(50)] },
  readAt: NOW,
});
const unreadReminder = note(3, {
  kind: 'UNCONFIRMED_ORDER',
  title: '3 orders waiting for confirmation',
  body: '#1, #2, #3 have been waiting more than 60 minutes.',
  data: { kind: 'UNCONFIRMED_ORDER', count: 3, orderIds: [uuid(51), uuid(52), uuid(53)] },
});

function notificationsApi(initial: Notification[], over: Record<string, unknown> = {}) {
  // Each test gets its own copies: reading one changes it.
  const items = initial.map((n) => ({ ...n }));
  const unread = () => items.filter((n) => n.readAt === null).length;
  return {
    notifications: {
      list: vi.fn(async () => ({ items, nextCursor: null as string | null })),
      unreadCount: vi.fn(async () => ({ count: unread() })),
      markRead: vi.fn(async (id: string) => {
        const found = items.find((n) => n.id === id)!;
        found.readAt = NOW;
        return found;
      }),
      markAllRead: vi.fn(async () => {
        const updated = unread();
        for (const n of items) n.readAt ??= NOW;
        return { updated };
      }),
      ...over,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

describe('the notification bell', () => {
  it('shows how many are unread, in its name and as a badge, and links to the list', async () => {
    const api = notificationsApi([note(1), note(2), readOrder]);
    mount(<NotificationBell />, api);
    const bell = await screen.findByRole('link', { name: 'Notifications, 2 unread' });
    expect(bell).toHaveAttribute('href', '/notifications');
    expect(within(bell.parentElement!).getByText('2')).toBeTruthy();
  });

  it('has no badge when everything is read, and caps a long count', async () => {
    mount(<NotificationBell />, notificationsApi([readOrder]));
    expect(await screen.findByRole('link', { name: 'Notifications' })).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('shows 99+ for a very long count', async () => {
    const api = notificationsApi([], { unreadCount: async () => ({ count: 250 }) });
    mount(<NotificationBell />, api);
    expect(await screen.findByRole('link', { name: 'Notifications, 250 unread' })).toBeTruthy();
    expect(screen.getByText('99+')).toBeTruthy();
  });

  it('asks again every minute while the app is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = notificationsApi([unreadLowStock]);
    mount(<NotificationBell />, api);
    await waitFor(() => expect(api.notifications.unreadCount).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(api.notifications.unreadCount).toHaveBeenCalledTimes(2));
  });

  it('asks again when the person comes back to the window', async () => {
    const api = notificationsApi([unreadLowStock]);
    mount(<NotificationBell />, api);
    await waitFor(() => expect(api.notifications.unreadCount).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(api.notifications.unreadCount).toHaveBeenCalledTimes(2));
  });
});

describe('the notifications screen', () => {
  it('lists them newest first, with the unread ones marked in words', async () => {
    mount(<NotificationsScreen />, notificationsApi([unreadLowStock, readOrder, unreadReminder]));
    expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeTruthy();
    expect(await screen.findByText('Low stock: 2 items')).toBeTruthy();
    expect(screen.getByText('New order #1042')).toBeTruthy();
    expect(screen.getByText('3 orders waiting for confirmation')).toBeTruthy();
    // "New" appears on the two unread ones only.
    expect(screen.getAllByText('New')).toHaveLength(2);
    const readRow = screen.getByRole('button', { name: /New order #1042/ });
    expect(within(readRow).queryByText('New')).toBeNull();
  });

  it('marks one read and opens what it is about when tapped', async () => {
    const api = notificationsApi([unreadLowStock, readOrder, unreadReminder]);
    const { navigation } = mount(<NotificationsScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: /Low stock: 2 items/ }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/products?tab=low'));
    expect(api.notifications.markRead).toHaveBeenCalledWith(uuid(1));
  });

  it('opens an order directly when the notification is about one, without marking a read one again', async () => {
    const api = notificationsApi([unreadLowStock, readOrder]);
    const { navigation } = mount(<NotificationsScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: /New order #1042/ }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith(`/orders/${uuid(50)}`));
    expect(api.notifications.markRead).not.toHaveBeenCalled();
  });

  it('opens the waiting orders when a reminder is about several', async () => {
    const api = notificationsApi([unreadReminder]);
    const { navigation } = mount(<NotificationsScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: /waiting for confirmation/ }));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith('/orders?status=pending_confirmation'),
    );
  });

  it('still opens the screen when it could not be marked read, and says why', async () => {
    const api = notificationsApi([unreadLowStock], {
      markRead: async () => {
        throw new ApiError('offline', undefined, 'offline');
      },
    });
    const { navigation } = mount(<NotificationsScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: /Low stock/ }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/products?tab=low'));
    expect(await screen.findByText('offline')).toBeTruthy();
  });

  it('marks all read, and the button is off when there is nothing unread', async () => {
    const api = notificationsApi([unreadLowStock, unreadReminder]);
    mount(<NotificationsScreen />, api);
    const all = await screen.findByRole('button', { name: 'Mark all read' });
    await waitFor(() => expect(all).not.toHaveAttribute('aria-disabled', 'true'));
    await userEvent.click(all);
    await waitFor(() => expect(api.notifications.markAllRead).toHaveBeenCalledTimes(1));
    // The list and the count are fetched again, and now nothing is unread.
    await waitFor(() => expect(screen.queryAllByText('New')).toHaveLength(0));
    expect(screen.getByRole('button', { name: 'Mark all read' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('loads the next page by cursor', async () => {
    const second = note(7, { title: 'Daily report 2026-10-25', kind: 'DAILY_REPORT', readAt: NOW });
    const list = vi.fn(async (query: { cursor?: string } = {}) =>
      query.cursor
        ? { items: [second], nextCursor: null }
        : { items: [unreadLowStock], nextCursor: 'next-1' },
    );
    mount(<NotificationsScreen />, notificationsApi([unreadLowStock], { list }));
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Daily report 2026-10-25')).toBeTruthy();
    expect(list).toHaveBeenLastCalledWith({ cursor: 'next-1' });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says so when there is nothing to show', async () => {
    mount(<NotificationsScreen />, notificationsApi([]));
    expect(await screen.findByText('You are all caught up')).toBeTruthy();
  });

  it('says so when it cannot load, and tries again', async () => {
    let fail = true;
    const list = vi.fn(async () => {
      if (fail) throw new ApiError('x', undefined, 'network_error');
      return { items: [unreadLowStock], nextCursor: null };
    });
    mount(<NotificationsScreen />, notificationsApi([unreadLowStock], { list }));
    expect(await screen.findByText(/Cannot reach the server/)).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Low stock: 2 items')).toBeTruthy();
  });

  it('says so when the device is offline and nothing was loaded before', async () => {
    const connectivity = createConnectivityStore(false);
    // The app knows it is offline before its first request (the phone says so at start-up).
    onlineManager.setOnline(false);
    mount(<NotificationsScreen />, notificationsApi([unreadLowStock]), 'OWNER', { connectivity });
    expect(await screen.findByText('You are offline')).toBeTruthy();
  });

  it('offers no phone alerts on the web (no push platform)', async () => {
    mount(<NotificationsScreen />, notificationsApi([]));
    await screen.findByText('You are all caught up');
    expect(screen.queryByText('Get alerts on this phone')).toBeNull();
  });
});

function phone(permission: PushPermission, supported = true) {
  const state = { permission };
  const platform: PushPlatform = {
    supported,
    permission: vi.fn(async () => state.permission),
    requestPermission: vi.fn(async () => {
      state.permission = 'granted';
      return state.permission;
    }),
    token: vi.fn(async () => ({ token: 'ExponentPushToken[abc123]', platform: 'ios' as const })),
    onTokenChange: () => () => undefined,
    onReceived: () => () => undefined,
    onOpened: () => () => undefined,
  };
  return platform;
}

describe('turning on alerts for a phone', () => {
  const setup = (permission: PushPermission, supported = true) => {
    const api = {
      ...notificationsApi([]),
      pushDevices: { register: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) },
    };
    const platform = phone(permission, supported);
    const push = new PushRegistrar(platform, api as never);
    return { api, platform, push };
  };

  it('explains first and asks the system only when the person presses Turn on', async () => {
    const { api, platform, push } = setup('undetermined');
    mount(<NotificationsScreen />, api, 'OWNER', { push });
    expect(await screen.findByText('Get alerts on this phone')).toBeTruthy();
    expect(platform.requestPermission).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(api.pushDevices.register).toHaveBeenCalledTimes(1));
    expect(platform.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Get alerts on this phone')).toBeNull());
  });

  it('goes away for now on "Not now" without asking', async () => {
    const { api, platform, push } = setup('undetermined');
    mount(<NotificationsScreen />, api, 'OWNER', { push });
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByText('Get alerts on this phone')).toBeNull();
    expect(platform.requestPermission).not.toHaveBeenCalled();
  });

  it('is not shown on a phone that has already chosen, or cannot do push', async () => {
    for (const [permission, supported] of [
      ['granted', true],
      ['denied', true],
      ['undetermined', false],
    ] as const) {
      const { api, push } = setup(permission, supported);
      const view = mount(<NotificationsScreen />, api, 'OWNER', { push });
      await screen.findByText('You are all caught up');
      expect(screen.queryByText('Get alerts on this phone')).toBeNull();
      view.unmount();
    }
  });

  it('shows the state of this phone in the preferences, with a way to turn it on or what to do when it is off', async () => {
    const asked = setup('denied');
    const view = mount(
      <NotificationPreferencesScreen />,
      {
        ...asked.api,
        notifications: { ...asked.api.notifications, preferences: async () => ({ items: [] }) },
      },
      'OWNER',
      { push: asked.push },
    );
    expect(await screen.findByText(/off for OrderLoop in your phone’s settings/)).toBeTruthy();
    view.unmount();

    const fresh = setup('undetermined');
    mount(
      <NotificationPreferencesScreen />,
      {
        ...fresh.api,
        notifications: { ...fresh.api.notifications, preferences: async () => ({ items: [] }) },
      },
      'OWNER',
      { push: fresh.push },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on alerts' }));
    expect((await screen.findAllByText('Alerts are on for this phone.')).length).toBeGreaterThan(0);
  });
});

const prefs = (over: Partial<NotificationPreference> = {}): NotificationPreference[] => [
  { kind: 'LOW_STOCK', inApp: true, push: true, email: false, available: true, ...over },
  {
    kind: 'COD_DISCREPANCY',
    inApp: true,
    push: true,
    email: false,
    available: false,
  },
];

describe('notification preferences', () => {
  function setup(items = prefs(), consents: unknown[] = []) {
    let current = items;
    return {
      notifications: {
        preferences: vi.fn(async () => ({ items: current })),
        updatePreferences: vi.fn(async (changes: Array<Record<string, unknown>>) => {
          current = current.map((p) => {
            const change = changes.find((c) => c.kind === p.kind);
            return change ? ({ ...p, ...change } as NotificationPreference) : p;
          });
          return { items: current };
        }),
      },
      messagingConsents: {
        get: vi.fn(async () => ({ items: consents })),
        update: vi.fn(async (body: Record<string, unknown>) => ({
          items: [
            {
              channel: body.channel,
              configured: true,
              granted: body.granted,
              phone: body.granted ? '+8801712345678' : null,
              grantedAt: NOW,
              revokedAt: null,
            },
          ],
        })),
      },
    };
  }

  it('shows each kind with its three channels and saves a change to one of them', async () => {
    const api = setup();
    mount(<NotificationPreferencesScreen />, api);
    const group = await screen.findByRole('group', { name: 'Low stock' });
    const push = within(group).getByRole('switch', { name: 'Push to my phone' });
    expect(within(group).getByRole('switch', { name: 'In the app' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(group).getByRole('switch', { name: 'Email' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await userEvent.click(push);
    await waitFor(() =>
      expect(api.notifications.updatePreferences).toHaveBeenCalledWith([
        { kind: 'LOW_STOCK', push: false },
      ]),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Low stock' })).getByRole('switch', {
          name: 'Push to my phone',
        }),
      ).toHaveAttribute('aria-checked', 'false'),
    );
  });

  it('shows what the person’s role cannot receive as off, with the reason', async () => {
    const api = setup();
    mount(<NotificationPreferencesScreen />, api, 'STAFF');
    const group = await screen.findByRole('group', { name: 'Cash on delivery differences' });
    expect(within(group).getByText(/Your role does not receive this alert/)).toBeTruthy();
    // A disabled switch ignores presses (the browser would not deliver them: skip the pointer-events check).
    const press = userEvent.setup({ pointerEventsCheck: 0 });
    for (const name of ['In the app', 'Push to my phone', 'Email']) {
      const toggle = within(group).getByRole('switch', { name });
      expect(toggle).toHaveAttribute('aria-disabled', 'true');
      await press.click(toggle);
    }
    expect(api.notifications.updatePreferences).not.toHaveBeenCalled();
    // The kind they can receive has no such note.
    expect(
      within(screen.getByRole('group', { name: 'Low stock' })).queryByText(/does not receive/),
    ).toBeNull();
  });

  it('says why a change was not saved and leaves the switch as it was', async () => {
    const api = setup();
    api.notifications.updatePreferences.mockRejectedValueOnce(
      new ApiError('x', undefined, 'network_error'),
    );
    mount(<NotificationPreferencesScreen />, api);
    const group = await screen.findByRole('group', { name: 'Low stock' });
    await userEvent.click(within(group).getByRole('switch', { name: 'Email' }));
    expect(await screen.findByText(/Cannot reach the server/)).toBeTruthy();
    expect(within(group).getByRole('switch', { name: 'Email' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('hides the text-message section when the server can send neither SMS nor WhatsApp', async () => {
    const api = setup(prefs(), [
      {
        channel: 'sms',
        configured: false,
        granted: false,
        phone: null,
        grantedAt: null,
        revokedAt: null,
      },
      {
        channel: 'whatsapp',
        configured: false,
        granted: false,
        phone: null,
        grantedAt: null,
        revokedAt: null,
      },
    ]);
    mount(<NotificationPreferencesScreen />, api);
    await screen.findByRole('group', { name: 'Low stock' });
    await waitFor(() => expect(api.messagingConsents.get).toHaveBeenCalled());
    expect(screen.queryByText('Text and WhatsApp alerts')).toBeNull();
  });

  const sms = {
    channel: 'sms',
    configured: true,
    granted: false,
    phone: null,
    grantedAt: null,
    revokedAt: null,
  };

  it('asks for a number before agreeing to SMS, and grants consent with it', async () => {
    const api = setup(prefs(), [sms]);
    mount(<NotificationPreferencesScreen />, api);
    expect(await screen.findByText('Text and WhatsApp alerts')).toBeTruthy();
    expect(screen.queryByText('WhatsApp', { selector: 'div' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Agree to get SMS alerts' }));
    expect(
      await screen.findByText('Enter your mobile number, for example 01712 345678.'),
    ).toBeTruthy();
    expect(api.messagingConsents.update).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Your SMS number'), '01712 345678');
    await userEvent.click(screen.getByRole('button', { name: 'Agree to get SMS alerts' }));
    await waitFor(() =>
      expect(api.messagingConsents.update).toHaveBeenCalledWith({
        channel: 'sms',
        granted: true,
        phone: '01712 345678',
      }),
    );
    expect(await screen.findByText('Alerts go to +8801712345678.')).toBeTruthy();
  });

  it('lets the person stop SMS alerts', async () => {
    const api = setup(prefs(), [
      { ...sms, granted: true, phone: '+8801712345678', grantedAt: NOW },
    ]);
    mount(<NotificationPreferencesScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Stop SMS alerts' }));
    await waitFor(() =>
      expect(api.messagingConsents.update).toHaveBeenCalledWith({ channel: 'sms', granted: false }),
    );
    expect(await screen.findByRole('button', { name: 'Agree to get SMS alerts' })).toBeTruthy();
  });

  it('shows the server’s reason when the number is refused', async () => {
    const api = setup(prefs(), [sms]);
    api.messagingConsents.update.mockRejectedValueOnce(
      new ApiError('Invalid request', 400, 'validation_failed', [
        { path: 'body.phone', message: 'Enter a Bangladeshi mobile number' },
      ]),
    );
    mount(<NotificationPreferencesScreen />, api);
    await userEvent.type(await screen.findByLabelText('Your SMS number'), '12345');
    await userEvent.click(screen.getByRole('button', { name: 'Agree to get SMS alerts' }));
    expect(await screen.findByText('Enter a Bangladeshi mobile number')).toBeTruthy();
  });
});
