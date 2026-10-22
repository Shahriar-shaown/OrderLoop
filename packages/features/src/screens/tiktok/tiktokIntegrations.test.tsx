import { ApiError } from '@orderloop/api-client';
import type { TikTokOauthSession, TikTokOrderPage, TikTokOverview } from '@orderloop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNamedControls, expectNamesContainVisibleText } from '../../../test/a11y';
import { mount } from '../../../test/mount';
import { leaveApp } from '../../lib/leaveApp';
import { OAUTH_ERRORS } from '../../lib/tiktok';
import { TikTokIntegrationsScreen } from './TikTokIntegrationsScreen';
import { catalogue, connection, MOCK_BANNER, overview, summary, uuid } from './fixtures';

vi.mock('../../lib/leaveApp', () => ({ leaveApp: vi.fn() }));

const result = (over: Record<string, unknown> = {}) => ({
  mode: 'mock' as const,
  mock: true as const,
  eventId: uuid(7),
  notificationId: 'n',
  duplicate: false,
  status: 'processed' as const,
  orderId: uuid(100),
  stockState: 'reserved' as const,
  ...over,
});

function tiktokApi(over: Partial<TikTokOverview> = {}, extra: Record<string, unknown> = {}) {
  let current = overview(over);
  return {
    ...catalogue('TEE-1'),
    tiktokOrders: {
      list: vi.fn(async (): Promise<TikTokOrderPage> => ({
        mode: 'mock',
        items: [],
        nextCursor: null,
        counts: {},
      })),
    },
    tiktokShop: {
      overview: vi.fn(async () => current),
      startOauth: vi.fn(async () => ({
        mode: 'live' as const,
        authorizeUrl: 'https://api.test/begin?ticket=t',
      })),
      reconnect: vi.fn(async () => ({
        mode: 'live' as const,
        authorizeUrl: 'https://api.test/begin?ticket=r',
      })),
      disconnect: vi.fn(async (id: string) => {
        const gone = current.connections.find((c) => c.id === id)!;
        current = {
          ...current,
          connections: current.connections.map((c) =>
            c.id === id ? { ...c, status: 'disconnected' as const } : c,
          ),
        };
        return { ...gone, status: 'disconnected' as const };
      }),
      sync: vi.fn(async () => ({
        mode: 'mock' as const,
        fetched: 0,
        updated: 0,
        reconciled: 3,
        truncated: false,
      })),
      mockConnection: vi.fn(async () => {
        const made = connection({ id: uuid(2), shopName: 'Mock TikTok shop 1' });
        current = { ...current, connections: [...current.connections, made] };
        return made;
      }),
      mockOrder: vi.fn(async () => result()),
      mockStatus: vi.fn(async () => result()),
      session: vi.fn(),
      connect: vi.fn(),
      ...extra,
    },
  };
}
const live = (over: Partial<TikTokOverview> = {}, extra: Record<string, unknown> = {}) =>
  tiktokApi({ mode: 'live', liveConfigured: true, ...over }, extra);

describe('TikTok integration: mock mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says loudly that it is a mock, and says what OrderLoop does and does not do', async () => {
    mount(<TikTokIntegrationsScreen />, tiktokApi({ connections: [connection()] }));
    expect(await screen.findByText(MOCK_BANNER)).toBeTruthy();
    expect(screen.getByText(/Nothing is sent to or received from TikTok Shop/)).toBeTruthy();
    expect(screen.getByText(/never changes anything on TikTok/)).toBeTruthy();
    expect(screen.getByText(/has not been tested with TikTok/)).toBeTruthy();
    expect(screen.getByText(/in the shop’s own currency, not taka/)).toBeTruthy();
    expect(screen.getByText(/does not store any buyer details/)).toBeTruthy();
    const card = within(await screen.findByRole('group', { name: 'Demo TikTok shop' }));
    expect(card.getByText('Mock')).toBeTruthy();
    expect(card.getByText('Active')).toBeTruthy();
    expect(card.getByText('MY')).toBeTruthy();
    expect(card.getByText('Local')).toBeTruthy();
    expect(card.getByText('Not synced yet')).toBeTruthy();
  });

  it('keeps the notice when a mock shop is left over after the server went live', async () => {
    mount(<TikTokIntegrationsScreen />, live({ connections: [connection()] }));
    expect(await screen.findByText(MOCK_BANNER)).toBeTruthy();
  });

  it('has the channel switcher at the top, and moves to the Meta page', async () => {
    const { navigation } = mount(<TikTokIntegrationsScreen />, tiktokApi());
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Facebook and Instagram', 'TikTok Shop']);
    expect(screen.getByRole('tab', { name: 'TikTok Shop' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Facebook and Instagram' }));
    expect(navigation.push).toHaveBeenCalledWith('/settings/integrations/meta');
  });

  it('explains why connecting is off in mock mode, and never calls it', async () => {
    const api = tiktokApi();
    mount(<TikTokIntegrationsScreen />, api);
    expect(await screen.findByRole('button', { name: 'Connect TikTok Shop' })).toBeDisabled();
    expect(screen.getByText(/turned off in mock mode/)).toBeTruthy();
    expect(api.tiktokShop.startOauth).not.toHaveBeenCalled();
  });

  it('adds a mock shop, then offers to send it an order', async () => {
    const api = tiktokApi();
    mount(<TikTokIntegrationsScreen />, api);
    expect(await screen.findByText('No shops connected yet')).toBeTruthy();
    expect(screen.getByText(/Add a mock shop first/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add mock shop' }));
    await waitFor(() =>
      expect(api.tiktokShop.mockConnection).toHaveBeenCalledWith({ region: 'MY', currency: 'MYR' }),
    );
    expect(await screen.findByRole('group', { name: 'Mock TikTok shop 1' })).toBeTruthy();
    expect(await screen.findByLabelText('SKU')).toBeTruthy();
  });

  it('checks the region and currency of a mock shop before sending them', async () => {
    const api = tiktokApi();
    mount(<TikTokIntegrationsScreen />, api);
    await userEvent.clear(await screen.findByLabelText('Currency'));
    await userEvent.type(screen.getByLabelText('Currency'), 'ringgit');
    await userEvent.click(screen.getByRole('button', { name: 'Add mock shop' }));
    expect(await screen.findByText('Three letters, for example MYR')).toBeTruthy();
    expect(api.tiktokShop.mockConnection).not.toHaveBeenCalled();
  });

  it('injects an order for a real SKU from the catalogue, in the shop currency', async () => {
    const api = tiktokApi({ connections: [connection()] });
    mount(<TikTokIntegrationsScreen />, api);
    const sku = await screen.findByLabelText('SKU');
    await waitFor(() => expect(sku).toHaveValue('TEE-1'));
    expect(screen.getByLabelText('Order status')).toHaveValue('AWAITING_SHIPMENT');
    expect(screen.getByLabelText('Unit price (MYR)')).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Quantity'));
    await userEvent.type(screen.getByLabelText('Quantity'), '3');
    await userEvent.clear(screen.getByLabelText('Unit price (MYR)'));
    await userEvent.type(screen.getByLabelText('Unit price (MYR)'), '12.50');
    await userEvent.click(screen.getByRole('button', { name: 'Send test order' }));
    await waitFor(() => expect(api.tiktokShop.mockOrder).toHaveBeenCalledTimes(1));
    expect(api.tiktokShop.mockOrder).toHaveBeenCalledWith({
      connectionId: uuid(1),
      status: 'AWAITING_SHIPMENT',
      onHold: false,
      items: [{ skuId: 'TEE-1', sellerSku: 'TEE-1', quantity: 3, unitPriceMinor: 1250 }],
    });
    expect(await screen.findByText('Order received.')).toBeTruthy();
    expect(screen.getByText(/Stock is held for this order/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the order' })).toHaveAttribute(
      'href',
      `/tiktok-orders/${uuid(100)}`,
    );
  });

  it('refuses a bad quantity, a price with too many decimals and an empty SKU', async () => {
    const api = tiktokApi({ connections: [connection()] });
    mount(<TikTokIntegrationsScreen />, api);
    const quantity = await screen.findByLabelText('Quantity');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Send test order' }));
    expect(await screen.findByText('Enter a whole number from 1 to 10000')).toBeTruthy();
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '1');
    await userEvent.type(screen.getByLabelText('Unit price (MYR)'), '.555');
    await userEvent.click(screen.getByRole('button', { name: 'Send test order' }));
    expect(await screen.findByText(/Enter an amount such as 12.00/)).toBeTruthy();
    expect(api.tiktokShop.mockOrder).not.toHaveBeenCalled();
  });

  it('says so when a replayed order created nothing', async () => {
    const api = tiktokApi({ connections: [connection()] });
    api.tiktokShop.mockOrder.mockResolvedValueOnce(result({ duplicate: true }));
    mount(<TikTokIntegrationsScreen />, api);
    const sku = await screen.findByLabelText('SKU');
    await waitFor(() => expect(sku).toHaveValue('TEE-1'));
    await userEvent.click(screen.getByRole('button', { name: 'Send test order' }));
    expect(await screen.findByText(/already received. Nothing new was created/)).toBeTruthy();
  });

  it('moves a test order to its next status, and cancels another', async () => {
    const api = tiktokApi({ connections: [connection()] });
    api.tiktokOrders.list.mockResolvedValue({
      mode: 'mock',
      items: [
        summary({ id: uuid(100), externalOrderId: 'TT-1' }),
        summary({
          id: uuid(101),
          externalOrderId: 'TT-2',
          status: 'CANCELLED',
          stockState: 'released',
        }),
        summary({
          id: uuid(102),
          externalOrderId: 'TT-3',
          status: 'COMPLETED',
          stockState: 'shipped',
        }),
      ],
      nextCursor: null,
      counts: {},
    });
    mount(<TikTokIntegrationsScreen />, api);
    const first = within(await screen.findByRole('group', { name: 'Test order TT-1' }));
    await userEvent.click(first.getByRole('button', { name: 'Move to In transit, order TT-1' }));
    await waitFor(() =>
      expect(api.tiktokShop.mockStatus).toHaveBeenCalledWith(uuid(100), { status: 'IN_TRANSIT' }),
    );
    await userEvent.click(first.getByRole('button', { name: 'Cancel order TT-1' }));
    await waitFor(() =>
      expect(api.tiktokShop.mockStatus).toHaveBeenLastCalledWith(uuid(100), {
        status: 'CANCELLED',
      }),
    );
    // A cancelled order has nowhere to go; a completed one can still be cancelled, but not moved on.
    const cancelled = within(screen.getByRole('group', { name: 'Test order TT-2' }));
    expect(cancelled.queryByRole('button')).toBeNull();
    const done = within(screen.getByRole('group', { name: 'Test order TT-3' }));
    expect(done.queryByRole('button', { name: /Move order/ })).toBeNull();
    expect(done.getByRole('button', { name: 'Cancel order TT-3' })).toBeTruthy();
  });

  it('syncs a shop and reports what was looked at again', async () => {
    const api = tiktokApi({ connections: [connection()] });
    mount(<TikTokIntegrationsScreen />, api);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Sync now, Demo TikTok shop' }),
    );
    await waitFor(() => expect(api.tiktokShop.sync).toHaveBeenCalledWith(uuid(1)));
    expect(await screen.findByText('Mock shop: waiting orders looked at again: 3')).toBeTruthy();
  });

  it('links to the orders and the SKU mapping, with what is waiting', async () => {
    mount(
      <TikTokIntegrationsScreen />,
      tiktokApi({
        connections: [connection()],
        needsMappingOrders: 2,
        stockShortOrders: 1,
        attentionOrders: 1,
        unmappedSkus: 3,
      }),
    );
    expect(await screen.findByText('Orders waiting for a product to be mapped: 2')).toBeTruthy();
    expect(screen.getByText('Orders waiting for stock: 1')).toBeTruthy();
    expect(screen.getByText('Orders cancelled after shipping, to check: 1')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open TikTok orders' })).toHaveAttribute(
      'href',
      '/tiktok-orders',
    );
    expect(screen.getByRole('link', { name: 'Map SKUs (3 waiting)' })).toHaveAttribute(
      'href',
      '/tiktok-orders/sku-mapping',
    );
  });

  it('has named controls, each named with its visible text', async () => {
    const api = tiktokApi({ connections: [connection()] });
    api.tiktokOrders.list.mockResolvedValue({
      mode: 'mock',
      items: [summary({ externalOrderId: 'TT-1' })],
      nextCursor: null,
      counts: {},
    });
    mount(<TikTokIntegrationsScreen />, api);
    await screen.findByRole('group', { name: 'Demo TikTok shop' });
    await screen.findByRole('group', { name: 'Test order TT-1' });
    expectNamedControls();
    expectNamesContainVisibleText();
  });
});

describe('TikTok integration: live mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is disabled with an explanation while the server is not set up, and shows no mock tools', async () => {
    mount(<TikTokIntegrationsScreen />, live({ liveConfigured: false }));
    expect(await screen.findByRole('button', { name: 'Connect TikTok Shop' })).toBeDisabled();
    expect(screen.getByText(/not set up on this server yet/)).toBeTruthy();
    expect(screen.queryByText(MOCK_BANNER)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add mock shop' })).toBeNull();
  });

  it('starts the sign-in and sends the browser to the address the API gave', async () => {
    const api = live();
    mount(<TikTokIntegrationsScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect TikTok Shop' }));
    await waitFor(() => expect(api.tiktokShop.startOauth).toHaveBeenCalledTimes(1));
    expect(leaveApp).toHaveBeenCalledWith('https://api.test/begin?ticket=t');
  });

  it('shows why the sign-in could not start', async () => {
    const api = live(
      {},
      {
        startOauth: vi.fn(async () => {
          throw new ApiError('x', 409, 'tiktok_not_configured');
        }),
      },
    );
    mount(<TikTokIntegrationsScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect TikTok Shop' }));
    expect(await screen.findByText(/not set up on this server, or this action/)).toBeTruthy();
    expect(leaveApp).not.toHaveBeenCalled();
  });

  it('points to the web app on the phone, and offers no sign-in button', async () => {
    mount(<TikTokIntegrationsScreen browserSignIn={false} />, live());
    expect(await screen.findByText('Connect from the web app')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect TikTok Shop' })).toBeNull();
  });

  const shops = (status: 'needs_reconnect' | 'permission_error' | 'disconnected' | 'active') =>
    live({
      connections: [
        connection({
          mock: false,
          status,
          shopName: 'Real shop',
          lastErrorCode: status === 'active' ? null : 'token_invalid',
          lastErrorMessage: status === 'active' ? null : 'Access was refused at 10:00.',
          lastSyncedAt: '2026-10-21T08:00:00.000Z',
        }),
      ],
    });

  it('says what each status means, shows the last error and the right action', async () => {
    const needs = mount(<TikTokIntegrationsScreen />, shops('needs_reconnect'));
    const card = within(await screen.findByRole('group', { name: 'Real shop' }));
    expect(card.getByText('Needs reconnecting')).toBeTruthy();
    expect(card.getByText(/no longer accepts the saved access/)).toBeTruthy();
    expect(card.getByText('TikTok did not accept the saved access.')).toBeTruthy();
    expect(card.getByText('Access was refused at 10:00.')).toBeTruthy();
    expect(card.getByText(/Last synced/)).toBeTruthy();
    expect(card.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(card.queryByRole('button', { name: /Sync/ })).toBeNull();
    needs.unmount();

    const perm = mount(<TikTokIntegrationsScreen />, shops('permission_error'));
    const p = within(await screen.findByRole('group', { name: 'Real shop' }));
    expect(p.getByText('Permission missing')).toBeTruthy();
    expect(p.getByRole('button', { name: 'Reconnect and approve all permissions' })).toBeTruthy();
    perm.unmount();

    const gone = mount(<TikTokIntegrationsScreen />, shops('disconnected'));
    const g = within(await screen.findByRole('group', { name: 'Real shop' }));
    expect(g.getByRole('button', { name: 'Connect again' })).toBeTruthy();
    expect(g.queryByRole('button', { name: /Disconnect/ })).toBeNull();
    gone.unmount();

    mount(<TikTokIntegrationsScreen />, shops('active'));
    await screen.findByRole('group', { name: 'Real shop' });
    expectNamesContainVisibleText();
    const a = within(await screen.findByRole('group', { name: 'Real shop' }));
    expect(a.getByRole('button', { name: 'Sync now, Real shop' })).toBeTruthy();
    expect(a.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });

  it('reconnects a shop through its own reconnect call, and a disconnected one through a new sign-in', async () => {
    const api = shops('needs_reconnect');
    mount(<TikTokIntegrationsScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(api.tiktokShop.reconnect).toHaveBeenCalledWith(uuid(1)));
    expect(leaveApp).toHaveBeenCalledWith('https://api.test/begin?ticket=r');
  });

  it('asks before disconnecting, and says nothing changes on TikTok', async () => {
    const api = shops('active');
    mount(<TikTokIntegrationsScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect Real shop' }));
    expect(await screen.findByText('Disconnect Real shop?')).toBeTruthy();
    expect(screen.getByText(/Nothing changes on TikTok/)).toBeTruthy();
    expect(api.tiktokShop.disconnect).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }),
    );
    await waitFor(() => expect(api.tiktokShop.disconnect).toHaveBeenCalledWith(uuid(1)));
    expect(await screen.findByText('Disconnected')).toBeTruthy();
  });
});

describe('TikTok sign-in return', () => {
  beforeEach(() => vi.clearAllMocks());

  it('explains every error code the sign-in can come back with', async () => {
    const codes = Object.keys(OAUTH_ERRORS);
    expect(codes.sort()).toEqual(
      [
        'access_denied',
        'invalid_state',
        'rate_limited',
        'tiktok_not_configured',
        'tiktok_permission_denied',
        'tiktok_token_invalid',
        'tiktok_unavailable',
      ].sort(),
    );
    for (const code of codes) {
      const view = mount(<TikTokIntegrationsScreen error={code} />, live());
      expect(await screen.findByText('Could not connect to TikTok Shop')).toBeTruthy();
      expect(screen.getByText(OAUTH_ERRORS[code]!)).toBeTruthy();
      view.unmount();
    }
  });

  it('gives a plain message for a code it does not know', async () => {
    mount(<TikTokIntegrationsScreen error="something_new" />, live());
    expect(await screen.findByText(/did not finish/)).toBeTruthy();
  });

  const session = (over: Partial<TikTokOauthSession> = {}): TikTokOauthSession => ({
    mode: 'live',
    id: uuid(50),
    expiresAt: '2026-10-21T10:00:00.000Z',
    reconnectConnectionId: null,
    shops: [
      { id: 'sh1', name: 'Shop One', region: 'MY', sellerType: 'LOCAL', alreadyConnected: false },
      {
        id: 'sh2',
        name: 'Shop Two',
        region: 'ID',
        sellerType: 'CROSS_BORDER',
        alreadyConnected: false,
      },
      { id: 'sh3', name: 'Shop Three', region: 'TH', sellerType: null, alreadyConnected: true },
    ],
    ...over,
  });
  const selectionApi = (connect: ReturnType<typeof vi.fn>) =>
    live({}, { session: vi.fn(async () => session()), connect });

  it('lists the shops with region and seller type, and cannot choose one that is already connected', async () => {
    mount(<TikTokIntegrationsScreen session={uuid(50)} />, selectionApi(vi.fn()));
    expect(await screen.findByText('Choose the shops to connect')).toBeTruthy();
    expect(await screen.findByText('ID')).toBeTruthy();
    expect(screen.getByText('Cross-border')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Shop Three' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('Already connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect selected' })).toBeDisabled();
  });

  it('connects the chosen shops and goes back to the page', async () => {
    const connect = vi.fn(async () => ({
      mode: 'live',
      connections: [connection(), connection({ id: uuid(3) })],
      failures: [],
    }));
    const { navigation } = mount(
      <TikTokIntegrationsScreen session={uuid(50)} />,
      selectionApi(connect),
    );
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Shop One' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Shop Two' }));
    await userEvent.click(screen.getByRole('button', { name: 'Connect selected' }));
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith({ sessionId: uuid(50), shopIds: ['sh1', 'sh2'] }),
    );
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith('/settings/integrations/tiktok-shop'),
    );
  });

  it('shows the shops that could not be connected, each with its reason, and keeps the rest', async () => {
    const connect = vi.fn(async () => ({
      mode: 'live',
      connections: [connection()],
      failures: [
        { shopId: 'sh2', code: 'conflict', message: 'taken' },
        { shopId: 'sh1', code: 'tiktok_permission_denied', message: 'no' },
      ],
    }));
    const { navigation } = mount(
      <TikTokIntegrationsScreen session={uuid(50)} />,
      selectionApi(connect),
    );
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Shop One' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Shop Two' }));
    await userEvent.click(screen.getByRole('button', { name: 'Connect selected' }));
    expect(await screen.findByText('Some shops could not be connected')).toBeTruthy();
    expect(screen.getByText(/already connected to another business/)).toBeTruthy();
    expect(screen.getByText(/did not give OrderLoop every permission/)).toBeTruthy();
    expect(screen.getByText('1 other shop was connected.')).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('shows an expired sign-in with a way back', async () => {
    const api = live(
      {},
      {
        session: vi.fn(async () => {
          throw new ApiError('x', 400, 'tiktok_oauth_invalid');
        }),
      },
    );
    mount(<TikTokIntegrationsScreen session={uuid(50)} />, api);
    expect(await screen.findByText(/sign-in with TikTok expired/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to integrations' })).toBeTruthy();
  });
});

describe('TikTok integration: permissions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets a manager look at shops but offers nothing to change', async () => {
    mount(
      <TikTokIntegrationsScreen />,
      tiktokApi({ connections: [connection({ status: 'needs_reconnect', mock: false })] }),
      'MANAGER',
    );
    const card = within(await screen.findByRole('group', { name: 'Demo TikTok shop' }));
    expect(card.getByText('Needs reconnecting')).toBeTruthy();
    expect(card.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Only an owner or admin can connect or change shops/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add mock shop' })).toBeNull();
    expect(screen.queryByLabelText('SKU')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect TikTok Shop' })).toBeNull();
  });

  it('keeps the page away from a role without integrations:read', async () => {
    const api = tiktokApi();
    mount(<TikTokIntegrationsScreen />, api, 'STAFF');
    expect(await screen.findByText('You do not have access to integrations')).toBeTruthy();
    expect(api.tiktokShop.overview).not.toHaveBeenCalled();
  });
});
