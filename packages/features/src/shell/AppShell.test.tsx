import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/mount';
import { AppShell } from './AppShell';

const api = (unread: number) => ({
  orders: { list: async () => ({ items: [], nextCursor: null, total: 0, statusCounts: {} }) },
  workspaces: { list: async () => [] },
  notifications: { unreadCount: vi.fn(async () => ({ count: unread })) },
});

describe('the app shell', () => {
  it('has the notification bell in the header, with the unread count', async () => {
    const { navigation } = mount(<AppShell>page</AppShell>, api(4));
    const bell = await screen.findByRole('link', { name: 'Notifications, 4 unread' });
    expect(within(bell.parentElement!).getByText('4')).toBeTruthy();
    await userEvent.click(bell);
    expect(navigation.push).toHaveBeenCalledWith('/notifications');
  });

  it('lists Automation in the menu for a role that may see it, and not for one that may not', async () => {
    const owner = mount(<AppShell>page</AppShell>, api(0));
    expect(await screen.findByRole('link', { name: 'Automation' })).toHaveAttribute(
      'href',
      '/automation',
    );
    owner.unmount();
    mount(<AppShell>page</AppShell>, api(0), 'ACCOUNTANT');
    await screen.findByRole('link', { name: 'Notifications' });
    expect(screen.queryByRole('link', { name: 'Automation' })).toBeNull();
  });

  it('reaches the notifications and their preferences from the account menu', async () => {
    const { navigation } = mount(<AppShell>page</AppShell>, api(0));
    await userEvent.click(await screen.findByRole('button', { name: /Account menu/ }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Notification preferences' }),
    );
    expect(navigation.push).toHaveBeenCalledWith('/notifications/preferences');
  });
});
