import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/mount';
import { AppShell } from './AppShell';

const api = (unread: number, tiktok = { needs: 0, short: 0, flagged: 0 }) => ({
  tiktokShop: {
    overview: vi.fn(async () => ({
      mode: 'mock',
      needsMappingOrders: tiktok.needs,
      stockShortOrders: tiktok.short,
      attentionOrders: tiktok.flagged,
    })),
  },
  tiktokOrders: {
    list: vi.fn(async () => ({
      mode: 'mock',
      items: [],
      nextCursor: null,
      counts: { needs_mapping: tiktok.needs, stock_short: tiktok.short, reserved: 9 },
    })),
  },
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

  it('lists TikTok orders with a badge of the orders that need a person: mapping, stock and attention', async () => {
    mount(<AppShell>page</AppShell>, api(0, { needs: 2, short: 1, flagged: 3 }));
    const link = await screen.findByRole('link', { name: /^TikTok orders/ });
    expect(link).toHaveAttribute('href', '/tiktok-orders');
    expect(await within(link).findByText('6')).toBeTruthy();
  });

  it('shows no TikTok badge when nothing needs a person', async () => {
    mount(<AppShell>page</AppShell>, api(0));
    const link = await screen.findByRole('link', { name: /^TikTok orders/ });
    await waitFor(() => expect(link.textContent).toBe('TikTok orders'));
  });

  it('counts the stock states from the order list for a role that cannot read integrations', async () => {
    const stub = api(0, { needs: 2, short: 1, flagged: 3 });
    mount(<AppShell>page</AppShell>, stub, 'ACCOUNTANT');
    const link = await screen.findByRole('link', { name: /^TikTok orders/ });
    expect(await within(link).findByText('3')).toBeTruthy();
    expect(stub.tiktokShop.overview).not.toHaveBeenCalled();
  });

  it('points Integrations at the Facebook and Instagram page by default', async () => {
    mount(<AppShell>page</AppShell>, api(0));
    const link = await screen.findByRole('link', { name: 'Integrations' });
    expect(link).toHaveAttribute('href', '/settings/integrations/meta');
  });
});
