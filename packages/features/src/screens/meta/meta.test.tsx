import { ApiError } from '@orderloop/api-client';
import type {
  MetaOverview,
  OauthSession,
  SocialConnection,
  SocialDraft,
  SocialDraftSummary,
} from '@orderloop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../../test/mount';
import { expectNamedControls } from '../../../test/a11y';
import { leaveApp } from '../../lib/leaveApp';
import { MOCK_MESSAGE, mockMessageId } from '../../lib/meta';
import { NewOrderScreen } from '../orders/NewOrderScreen';
import { MetaIntegrationsScreen } from './MetaIntegrationsScreen';
import { SocialDraftScreen } from './SocialDraftScreen';
import { SocialOrdersScreen } from './SocialOrdersScreen';

vi.mock('../../lib/leaveApp', () => ({ leaveApp: vi.fn() }));

const uuid = (n: number) => `0197b0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-10-21T09:00:00.000Z';
const MOCK_BANNER = 'Mock integration: not connected to Meta';

const connection = (over: Partial<SocialConnection> = {}): SocialConnection => ({
  id: uuid(1),
  provider: 'facebook_page',
  externalId: 'mock_abc',
  displayName: 'Demo Fashion Page',
  username: null,
  linkedPageId: null,
  status: 'active',
  mock: true,
  scopes: [],
  tokenExpiresAt: null,
  lastCheckedAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  connectedAt: NOW,
  disconnectedAt: null,
  ...over,
});
const overview = (over: Partial<MetaOverview> = {}): MetaOverview => ({
  mode: 'mock',
  liveConfigured: false,
  webhookUrl: null,
  scopes: [],
  connections: [],
  openDrafts: 0,
  ...over,
});

function metaApi(over: Partial<MetaOverview> = {}, extra: Record<string, unknown> = {}) {
  let current = overview(over);
  return {
    meta: {
      overview: vi.fn(async () => current),
      startOauth: vi.fn(async () => ({
        mode: 'live' as const,
        authorizeUrl: 'https://www.facebook.test/dialog',
        state: 's',
      })),
      reconnect: vi.fn(async () => ({
        mode: 'live' as const,
        authorizeUrl: 'https://www.facebook.test/reconnect',
        state: 's',
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
      mockConnection: vi.fn(async () => {
        const made = connection({ id: uuid(2), displayName: 'Mock Page 1' });
        current = { ...current, connections: [...current.connections, made] };
        return made;
      }),
      mockEvent: vi.fn(async () => ({
        mode: 'mock' as const,
        mock: true as const,
        eventId: uuid(7),
        messageId: 'm',
        duplicate: false,
        status: 'processed' as const,
        draftId: uuid(50),
      })),
      session: vi.fn(),
      connect: vi.fn(),
      ...extra,
    },
  };
}

describe('integrations: mock mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says loudly that it is a mock, in the notice and on each account', async () => {
    mount(<MetaIntegrationsScreen />, metaApi({ connections: [connection()] }));
    expect(await screen.findByText(MOCK_BANNER)).toBeTruthy();
    expect(
      screen.getByText(/Nothing is sent to or received from Facebook or Instagram/),
    ).toBeTruthy();
    const card = within(await screen.findByRole('group', { name: 'Demo Fashion Page' }));
    expect(card.getByText('Mock')).toBeTruthy();
    expect(card.getByText('Facebook')).toBeTruthy();
    expect(card.getByText('Active')).toBeTruthy();
  });

  it('keeps the notice when a mock account is left over after the server went live', async () => {
    mount(
      <MetaIntegrationsScreen />,
      metaApi({ mode: 'live', liveConfigured: true, connections: [connection()] }),
    );
    expect(await screen.findByText(MOCK_BANNER)).toBeTruthy();
  });

  it('adds a mock account, and then offers to send it a test message', async () => {
    const api = metaApi();
    mount(<MetaIntegrationsScreen />, api);
    expect(await screen.findByText('No accounts connected yet')).toBeTruthy();
    expect(screen.getByText(/Add a mock account first/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add mock account' }));
    await waitFor(() =>
      expect(api.meta.mockConnection).toHaveBeenCalledWith({ provider: 'facebook_page' }),
    );
    expect(await screen.findByRole('group', { name: 'Mock Page 1' })).toBeTruthy();
    expect(await screen.findByLabelText('Customer message')).toBeTruthy();
  });

  it('sends the Bangla example and links to the draft it made; the same text again is the same message', async () => {
    const api = metaApi({ connections: [connection()] });
    mount(<MetaIntegrationsScreen />, api);
    const text = await screen.findByLabelText('Customer message');
    expect(text).toHaveValue(MOCK_MESSAGE);
    expect(MOCK_MESSAGE).toContain('Demo Cotton T-Shirt');
    expect(screen.getByLabelText('Sender id')).toHaveValue('mock-customer-1');
    expect(
      screen.getByText(
        'Sending the same text again from the same sender will not create another draft.',
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Send test message' }));
    const link = await screen.findByRole('link', { name: 'Open the draft' });
    expect(link).toHaveAttribute('href', `/social-orders/${uuid(50)}`);
    await userEvent.click(screen.getByRole('button', { name: 'Send test message' }));
    await waitFor(() => expect(api.meta.mockEvent).toHaveBeenCalledTimes(2));
    const calls = api.meta.mockEvent.mock.calls as unknown as [Record<string, string>][];
    expect(calls[0]![0]).toMatchObject({
      connectionId: uuid(1),
      senderId: 'mock-customer-1',
      text: MOCK_MESSAGE,
    });
    expect(calls[1]![0]!.messageId).toBe(calls[0]![0]!.messageId);
    expect(calls[0]![0]!.messageId).toBe(mockMessageId(uuid(1), 'mock-customer-1', MOCK_MESSAGE));
    expect(mockMessageId(uuid(1), 'mock-customer-1', 'another text')).not.toBe(
      calls[0]![0]!.messageId,
    );
  });

  it('says so when a replayed message created nothing, or was not an order', async () => {
    const api = metaApi({ connections: [connection()] });
    api.meta.mockEvent.mockResolvedValueOnce({
      mode: 'mock',
      mock: true,
      eventId: uuid(7),
      messageId: 'm',
      duplicate: true,
      status: 'processed',
      draftId: uuid(50),
    });
    mount(<MetaIntegrationsScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Send test message' }));
    expect(await screen.findByText(/already received. Nothing new was created/)).toBeTruthy();
  });

  it('explains why connecting with Meta is off in mock mode, and never calls it', async () => {
    const api = metaApi();
    mount(<MetaIntegrationsScreen />, api);
    const connect = await screen.findByRole('button', { name: 'Connect Facebook & Instagram' });
    expect(connect).toBeDisabled();
    expect(screen.getByText(/turned off in mock mode/)).toBeTruthy();
    expect(api.meta.startOauth).not.toHaveBeenCalled();
  });
});

describe('integrations: live mode', () => {
  beforeEach(() => vi.clearAllMocks());
  const live = (over: Partial<MetaOverview> = {}) =>
    metaApi({ mode: 'live', liveConfigured: true, ...over });

  it('is disabled with an explanation while the server is not set up for Meta, and shows no mock tools', async () => {
    mount(<MetaIntegrationsScreen />, live({ liveConfigured: false }));
    expect(
      await screen.findByRole('button', { name: 'Connect Facebook & Instagram' }),
    ).toBeDisabled();
    expect(screen.getByText(/not set up on this server yet/)).toBeTruthy();
    expect(screen.queryByText(MOCK_BANNER)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add mock account' })).toBeNull();
  });

  it('starts the sign-in and sends the browser to Meta', async () => {
    const api = live();
    mount(<MetaIntegrationsScreen />, api);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect Facebook & Instagram' }),
    );
    await waitFor(() => expect(leaveApp).toHaveBeenCalledWith('https://www.facebook.test/dialog'));
  });

  it('shows a failed start as a message, not a redirect', async () => {
    const api = live();
    api.meta.startOauth.mockRejectedValueOnce(new ApiError('x', 409, 'meta_not_configured'));
    mount(<MetaIntegrationsScreen />, api);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect Facebook & Instagram' }),
    );
    expect(await screen.findByText(/Connecting to Meta is not set up on this server/)).toBeTruthy();
    expect(leaveApp).not.toHaveBeenCalled();
  });

  it('explains each status in plain words and offers the right action', async () => {
    const real = { mock: false, id: uuid(10) };
    const api = live({
      connections: [
        connection({ ...real, displayName: 'Ok Page', status: 'active' }),
        connection({
          ...real,
          id: uuid(11),
          displayName: 'Old Page',
          status: 'needs_reconnect',
          lastErrorMessage: 'Meta no longer accepts the saved access.',
        }),
        connection({ ...real, id: uuid(12), displayName: 'Thin Page', status: 'permission_error' }),
        connection({ ...real, id: uuid(13), displayName: 'Gone Page', status: 'disconnected' }),
      ],
    });
    mount(<MetaIntegrationsScreen />, api);
    const ok = within(await screen.findByRole('group', { name: 'Ok Page' }));
    expect(ok.getByText(/reach OrderLoop as draft orders/)).toBeTruthy();
    expect(ok.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    expect(ok.queryByRole('button', { name: 'Reconnect' })).toBeNull();

    const old = within(screen.getByRole('group', { name: 'Old Page' }));
    expect(old.getByText('Needs reconnecting')).toBeTruthy();
    expect(
      old.getByText(/no longer accepts the saved access, for example after a password change/),
    ).toBeTruthy();
    await userEvent.click(old.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(api.meta.reconnect).toHaveBeenCalledWith(uuid(11)));
    await waitFor(() =>
      expect(leaveApp).toHaveBeenCalledWith('https://www.facebook.test/reconnect'),
    );

    const thin = within(screen.getByRole('group', { name: 'Thin Page' }));
    expect(thin.getByText('Permission missing')).toBeTruthy();
    expect(
      thin.getByRole('button', { name: 'Reconnect and approve all permissions' }),
    ).toBeTruthy();

    const gone = within(screen.getByRole('group', { name: 'Gone Page' }));
    expect(gone.getByText('Disconnected')).toBeTruthy();
    expect(gone.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    await userEvent.click(gone.getByRole('button', { name: 'Connect again' }));
    await waitFor(() => expect(api.meta.startOauth).toHaveBeenCalled());
  });

  it('disconnects only after the person confirms', async () => {
    const api = live({ connections: [connection({ mock: false })] });
    mount(<MetaIntegrationsScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/stops receiving messages from this account/)).toBeTruthy();
    expect(api.meta.disconnect).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.meta.disconnect).toHaveBeenCalledWith(uuid(1)));
    expect(await screen.findByText('Disconnected')).toBeTruthy();
  });

  it('on the phone: shows the status and says to connect from the web app', async () => {
    const api = live({
      connections: [connection({ mock: false, status: 'needs_reconnect' })],
    });
    mount(<MetaIntegrationsScreen browserSignIn={false} />, api);
    expect(await screen.findByText('Connect from the web app')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Facebook & Instagram' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.getByText(/Reconnect from the web app/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('on the phone in mock mode: the mock tools still work', async () => {
    mount(
      <MetaIntegrationsScreen browserSignIn={false} />,
      metaApi({ connections: [connection()] }),
    );
    expect(await screen.findByRole('button', { name: 'Send test message' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add mock account' })).toBeTruthy();
  });
});

describe('integrations: coming back from Meta', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['access_denied', /cancelled the sign-in/],
    ['invalid_state', /expired or was already used/],
    ['meta_not_configured', /not set up on this server/],
    ['meta_permission_denied', /every permission/],
    ['meta_token_invalid', /did not accept the sign-in/],
    ['meta_unavailable', /could not be reached/],
    ['rate_limited', /slow down/],
    ['something_new', /did not finish/],
  ])('says what %s means', async (code, words) => {
    mount(<MetaIntegrationsScreen error={code} />, metaApi({ mode: 'live', liveConfigured: true }));
    expect(await screen.findByText('Could not connect to Meta')).toBeTruthy();
    expect(screen.getByText(words)).toBeTruthy();
  });

  const session = (over: Partial<OauthSession> = {}): OauthSession => ({
    mode: 'live',
    id: uuid(90),
    expiresAt: NOW,
    reconnectConnectionId: null,
    pages: [
      {
        id: 'p1',
        name: 'Rina Boutique',
        instagram: { id: 'i1', username: 'rina_boutique' },
        alreadyConnected: false,
      },
      { id: 'p2', name: 'Old Shop', instagram: null, alreadyConnected: true },
      { id: 'p3', name: 'Broken Page', instagram: null, alreadyConnected: false },
    ],
    ...over,
  });
  const withSession = (connect = vi.fn()) =>
    metaApi(
      { mode: 'live', liveConfigured: true },
      { session: vi.fn(async () => session()), connect },
    );

  it('lists the Pages with their Instagram accounts, and cannot select one that is already connected', async () => {
    const api = withSession();
    mount(<MetaIntegrationsScreen session={uuid(90)} />, api);
    expect(await screen.findByText('Choose the Pages to connect')).toBeTruthy();
    expect(api.meta.session).toHaveBeenCalledWith(uuid(90));
    expect(await screen.findByText('Instagram @rina_boutique')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Old Shop' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('Already connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect selected' })).toBeDisabled();
  });

  it('connects the chosen Pages and returns to the list', async () => {
    const connect = vi.fn(async () => ({
      mode: 'live' as const,
      connections: [connection({ mock: false })],
      failures: [],
    }));
    const { navigation } = mount(
      <MetaIntegrationsScreen session={uuid(90)} />,
      withSession(connect),
    );
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Rina Boutique' }));
    await userEvent.click(screen.getByRole('button', { name: 'Connect selected' }));
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith({ sessionId: uuid(90), pageIds: ['p1'] }),
    );
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith('/settings/integrations/meta'),
    );
  });

  it('shows which Page could not be connected and why, while the others are connected', async () => {
    const connect = vi.fn(async () => ({
      mode: 'live' as const,
      connections: [connection({ mock: false })],
      failures: [{ pageId: 'p3', code: 'meta_messages_access_off', message: 'server words' }],
    }));
    const { navigation } = mount(
      <MetaIntegrationsScreen session={uuid(90)} />,
      withSession(connect),
    );
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Rina Boutique' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Broken Page' }));
    await userEvent.click(screen.getByRole('button', { name: 'Connect selected' }));
    expect(await screen.findByText('Some Pages could not be connected')).toBeTruthy();
    expect(screen.getByText(/Turn on “Allow access to messages”/)).toBeTruthy();
    expect(screen.getByText(/1 other account was connected/)).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('says when the sign-in session has expired', async () => {
    const api = metaApi(
      { mode: 'live', liveConfigured: true },
      {
        session: vi.fn(async () => Promise.reject(new ApiError('gone', 400, 'meta_oauth_invalid'))),
      },
    );
    mount(<MetaIntegrationsScreen session={uuid(90)} />, api);
    expect(await screen.findByText(/sign-in with Meta expired or is not valid/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to integrations' })).toBeTruthy();
  });
});

describe('integrations: who may do what', () => {
  it('lets a manager look but offers no action', async () => {
    const api = metaApi({ connections: [connection()] });
    mount(<MetaIntegrationsScreen />, api, 'MANAGER');
    expect(await screen.findByRole('group', { name: 'Demo Fashion Page' })).toBeTruthy();
    expect(screen.getByText(/Only an owner or admin can connect or change accounts/)).toBeTruthy();
    expect(screen.getByText(MOCK_BANNER)).toBeTruthy();
    for (const name of [
      'Disconnect',
      'Add mock account',
      'Send test message',
      'Connect Facebook & Instagram',
    ])
      expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('keeps people without integrations:read out, without asking the server', async () => {
    const api = metaApi();
    mount(<MetaIntegrationsScreen />, api, 'ACCOUNTANT');
    expect(await screen.findByText('You do not have access to integrations')).toBeTruthy();
    expect(api.meta.overview).not.toHaveBeenCalled();
  });
});

// ---- the inbox -----------------------------------------------------------------------------------------------------------

const summary = (n: number, over: Partial<SocialDraftSummary> = {}): SocialDraftSummary => ({
  id: uuid(100 + n),
  status: 'needs_review',
  mock: true,
  provider: 'facebook_page',
  connectionId: uuid(1),
  connectionName: 'Demo Fashion Page',
  senderId: 'mock-customer-1',
  customerName: 'রিনা',
  phone: '+8801712345678',
  snippet: 'আমি ২টা Demo Cotton T-Shirt নিব',
  itemCount: 2,
  unmatchedItemCount: 0,
  messageCount: 1,
  firstMessageAt: NOW,
  lastMessageAt: NOW,
  orderId: null,
  orderNumber: null,
  ...over,
});
const draftPage = (items: SocialDraftSummary[], over: Record<string, unknown> = {}) => ({
  mode: 'mock' as const,
  items,
  nextCursor: null,
  counts: { needs_review: items.length, confirmed: 4, dismissed: 1 },
  ...over,
});

describe('the social orders inbox', () => {
  it('masks the phone number in the list and says the source', async () => {
    const list = vi.fn(async () => draftPage([summary(1, { unmatchedItemCount: 1 })]));
    mount(<SocialOrdersScreen />, { socialDrafts: { list } });
    const row = await screen.findByRole('row', { name: /Draft from/ });
    expect(within(row).getByText('017••••5678')).toBeTruthy();
    expect(screen.queryByText(/01712345678|\+8801712345678|01712-345678/)).toBeNull();
    expect(within(row).getByText('Facebook')).toBeTruthy();
    expect(within(row).getByText('Mock')).toBeTruthy();
    expect(within(row).getByText('1 to pick')).toBeTruthy();
    expect(screen.getByText(MOCK_BANNER)).toBeTruthy();
    expectNamedControls();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ status: 'needs_review' }));
  });

  it('shows the start of the first message under the phone, as the customer wrote it', async () => {
    const long = 'a'.repeat(60);
    const list = vi.fn(async () =>
      draftPage([summary(1), summary(2, { snippet: long }), summary(3, { snippet: null })]),
    );
    mount(<SocialOrdersScreen />, { socialDrafts: { list } }, 'OWNER');
    expect(await screen.findByText('আমি ২টা Demo Cotton T-Shirt নিব')).toBeTruthy();
    expect(screen.getByText(`${long}…`)).toBeTruthy();
  });

  it('shows the order number of a confirmed draft, linked to the order', async () => {
    const list = vi.fn(async () =>
      draftPage([summary(2, { status: 'confirmed', orderId: uuid(9), orderNumber: 123 })]),
    );
    mount(<SocialOrdersScreen />, { socialDrafts: { list } });
    const link = await screen.findByRole('link', { name: 'Order #123' });
    expect(link).toHaveAttribute('href', `/orders/${uuid(9)}`);
  });

  it('filters by status with the counts the server gives, and opens a draft on press', async () => {
    const list = vi.fn(async (q: { status?: string }) =>
      q.status === 'confirmed'
        ? draftPage([summary(2, { status: 'confirmed', orderId: uuid(9) })])
        : draftPage([summary(1)]),
    );
    const { navigation } = mount(<SocialOrdersScreen />, { socialDrafts: { list } });
    expect(await screen.findByRole('tab', { name: 'Needs review 1' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Confirmed 4' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Dismissed 1' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: /^Confirmed/ }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'confirmed' })),
    );
    const row = await screen.findByRole('row', { name: /Draft from/ });
    expect(within(row).getByText('Confirmed')).toBeTruthy();
    await userEvent.click(row);
    expect(navigation.push).toHaveBeenCalledWith(`/social-orders/${uuid(102)}`);
  });

  it('loads the next page by cursor', async () => {
    const list = vi.fn(async (q: { cursor?: string }) =>
      q.cursor === 'c2'
        ? draftPage([summary(2, { customerName: 'Sadia' })], { nextCursor: null })
        : draftPage([summary(1, { customerName: 'Rina' })], { nextCursor: 'c2' }),
    );
    mount(<SocialOrdersScreen />, { socialDrafts: { list } });
    await screen.findByText('Rina');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Sadia')).toBeTruthy();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c2' }));
  });

  it('explains how drafts arrive and that nothing is ordered until confirmed, when empty', async () => {
    const list = vi.fn(async () => draftPage([]));
    mount(<SocialOrdersScreen />, { socialDrafts: { list } });
    expect(await screen.findByText('No messages to review')).toBeTruthy();
    expect(screen.getByText(/Nothing is ordered until someone confirms it/)).toBeTruthy();
  });

  it('is for people who can read orders', async () => {
    mount(<SocialOrdersScreen />, { socialDrafts: { list: vi.fn() } }, 'STAFF');
    expect(await screen.findByRole('heading', { name: 'Social orders' })).toBeTruthy();
    // Staff can read orders: they see the screen.
    expect(screen.queryByText('You do not have access to orders')).toBeNull();
  });
});

// ---- reviewing one draft -------------------------------------------------------------------------------------------------

const variantId = uuid(500);
const catalogue = {
  id: variantId,
  productId: 'p',
  sku: 'TEE-1',
  name: 'Red / M',
  attributes: {},
  priceMinor: 85_050,
  costMinor: null,
  barcode: null,
  reorderPoint: 0,
  archived: false,
  stock: { onHand: 9, reserved: 0, available: 9, damaged: 0 },
};
const matched = {
  variantId,
  text: 'Demo Cotton T-Shirt',
  quantity: 2,
  confidence: 1,
  sourceEventIds: [],
  edited: false,
  match: {
    sku: 'TEE-1',
    productName: 'Cotton tee',
    variantName: 'Red / M',
    priceMinor: 85_050,
    available: 9,
  },
};
const unmatched = {
  variantId: null,
  text: 'লাল পাঞ্জাবি',
  quantity: 1,
  confidence: 0.4,
  sourceEventIds: [],
  edited: false,
  match: null,
};
const field = (value: string, confidence = 0.9, edited = false) => ({
  value,
  confidence,
  sourceEventIds: [],
  edited,
});

const draft = (over: Partial<SocialDraft> = {}): SocialDraft => ({
  ...summary(1),
  mode: 'mock',
  fields: {
    customerName: field('Rina Akter'),
    phone: field('+8801712345678', 0.5),
    address: field('House 5, Road 3'),
    district: field('Dhaka'),
    items: [matched],
  },
  suggestedDivision: 'Dhaka',
  warnings: [],
  messages: [
    { id: uuid(60), text: 'আমি ২টা Demo Cotton T-Shirt নিব', attachmentTypes: [], at: NOW },
    { id: uuid(61), text: null, attachmentTypes: ['image'], at: NOW },
  ],
  duplicates: [],
  dismissedReason: null,
  reviewedAt: null,
  createdAt: NOW,
  ...over,
});

const order = (id = 'new1') => ({ id, orderNumber: 1001 });

function reviewApi(d: SocialDraft, extra: Record<string, unknown> = {}) {
  return {
    socialDrafts: {
      get: vi.fn(async () => d),
      update: vi.fn(async () => d),
      confirm: vi.fn(async () => ({ draft: d, order: order() })),
      dismiss: vi.fn(async () => ({ ...d, status: 'dismissed' as const })),
      list: vi.fn(async () => draftPage([])),
      ...extra,
    },
    customers: {
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      get: vi.fn(),
    },
    products: {
      list: vi.fn(async () => ({
        items: [{ id: 'p', name: 'Cotton tee', variants: [catalogue] }],
        nextCursor: null,
      })),
    },
    orders: { create: vi.fn(), checkDuplicates: vi.fn(async () => []) },
  };
}

describe('reviewing a draft', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows what the customer wrote word for word, and the form filled in from it', async () => {
    mount(<SocialDraftScreen id={uuid(101)} />, reviewApi(draft()));
    expect(await screen.findByText('আমি ২টা Demo Cotton T-Shirt নিব')).toBeTruthy();
    expect(screen.getByText('Attachment: image (not shown)')).toBeTruthy();
    expect(screen.getAllByDisplayValue('Rina Akter')).toHaveLength(2); // customer and recipient
    expect(screen.getByDisplayValue('01712-345678')).toBeTruthy();
    expect(screen.getByDisplayValue('House 5, Road 3')).toBeTruthy();
    expect(screen.getAllByDisplayValue('Dhaka').length).toBeGreaterThanOrEqual(2); // district and division
    expect(screen.getByText(MOCK_BANNER)).toBeTruthy();
    expectNamedControls();
    expect(screen.queryByRole('button', { name: 'Save as draft' })).toBeNull();
  });

  it('takes products and prices from the catalogue, never from the chat', async () => {
    mount(<SocialDraftScreen id={uuid(101)} />, reviewApi(draft()));
    expect(await screen.findByText('Cotton tee — Red / M')).toBeTruthy();
    expect(screen.getByText(/TEE-1 · 9 in stock/)).toBeTruthy();
    expect(screen.getByText('× ৳850.50')).toBeTruthy();
    expect(screen.getByText('“Demo Cotton T-Shirt”')).toBeTruthy();
    expect(screen.getByLabelText('Quantity (TEE-1)')).toHaveValue('2');
  });

  it('marks only the low-confidence fields as "check this", and drops the mark when the person changes the field', async () => {
    mount(<SocialDraftScreen id={uuid(101)} />, reviewApi(draft()));
    const phone = await screen.findByDisplayValue('01712-345678');
    expect(screen.getAllByText(/^Check this: it was hard to read/)).toHaveLength(1);
    expect(phone).toHaveAccessibleDescription(/Check this/);
    await userEvent.type(phone, '9');
    expect(screen.queryByText(/^Check this: it was hard to read/)).toBeNull();
  });

  it('does not mark a field the person already corrected', async () => {
    const d = draft({
      fields: { ...draft().fields, phone: field('+8801712345678', 0.2, true), items: [matched] },
    });
    mount(<SocialDraftScreen id={uuid(101)} />, reviewApi(d));
    await screen.findByDisplayValue('01712-345678');
    expect(screen.queryByText(/^Check this: it was hard to read/)).toBeNull();
  });

  it('lists each warning in plain language', async () => {
    const d = draft({
      warnings: ['no_address', 'multiple_phones', 'price_ignored', 'unmatched_item'].map(
        (code) => ({
          code,
          message: `server ${code}`,
        }),
      ),
    });
    mount(<SocialDraftScreen id={uuid(101)} />, reviewApi(d));
    expect(await screen.findByText('Check before you confirm')).toBeTruthy();
    expect(screen.getByText(/No delivery address was found/)).toBeTruthy();
    expect(screen.getByText(/more than one phone number/)).toBeTruthy();
    expect(screen.getByText(/prices always come from your catalogue/)).toBeTruthy();
    expect(screen.getByText(/do not match a product in your catalogue/)).toBeTruthy();
    expect(screen.queryByText(/server no_address/)).toBeNull();
  });

  it('asks for the product of an unmatched item, and will not confirm until it is picked', async () => {
    const d = draft({ fields: { ...draft().fields, items: [matched, unmatched] } });
    const api = reviewApi(d);
    mount(<SocialDraftScreen id={uuid(101)} />, api);
    expect(await screen.findByText('Pick the product for these items')).toBeTruthy();
    expect(screen.getByText('“লাল পাঞ্জাবি” × 1')).toBeTruthy();
    await userEvent.type(
      await screen.findByLabelText('Thana / upazila', { exact: false }),
      'Mirpur',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    expect(
      await screen.findByText(/Pick the product for every item the customer asked for/),
    ).toBeTruthy();
    expect(api.socialDrafts.confirm).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Pick the product for “লাল পাঞ্জাবি”' }),
    );
    await userEvent.type(await screen.findByLabelText('Find a product for “লাল পাঞ্জাবি”'), 'tee');
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByText('Pick the product for these items')).toBeNull());
    // Same product as the first line: the quantities add up (2 + 1).
    expect(screen.getByLabelText('Quantity (TEE-1)')).toHaveValue('3');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    await waitFor(() => expect(api.socialDrafts.confirm).toHaveBeenCalledTimes(1));
  });

  it('lists possible duplicates with links, and needs the acknowledgement before Confirm is enabled', async () => {
    const d = draft({
      duplicates: [
        {
          orderId: uuid(900),
          orderNumber: 1042,
          status: 'confirmed',
          createdAt: NOW,
          totalMinor: 170_100,
          reasons: ['Same phone number and item'],
        },
      ],
    });
    const api = reviewApi(d);
    mount(<SocialDraftScreen id={uuid(101)} />, api);
    const link = await screen.findByRole('link', { name: 'Order #1042' });
    expect(link).toHaveAttribute('href', `/orders/${uuid(900)}`);
    expect(screen.getByText(/Same phone number and item/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Confirm order' });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'This is a different order' }));
    expect(screen.getByRole('button', { name: 'Confirm order' })).toBeEnabled();
  });

  it('confirms with exactly the payload the normal order form sends, and one idempotency key', async () => {
    const d = draft();
    const api = reviewApi(d);
    const first = mount(<SocialDraftScreen id={uuid(101)} />, api);
    const { navigation } = first;
    await userEvent.type(
      await screen.findByLabelText('Thana / upazila', { exact: false }),
      'Dhanmondi',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    await waitFor(() => expect(api.socialDrafts.confirm).toHaveBeenCalledTimes(1));
    const [id, sent] = (
      api.socialDrafts.confirm.mock.calls as unknown as [string, Record<string, unknown>][]
    )[0]!;
    expect(id).toBe(uuid(101));
    expect(sent.idempotencyKey).toEqual(expect.stringMatching(/^app-/));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/orders/new1'));
    first.unmount();

    // The same details through the normal form.
    const normal = reviewApi(d);
    const create = vi.fn(async () => order('n2'));
    normal.orders.create = create;
    const view = mount(<NewOrderScreen />, normal);
    await userEvent.click(await view.findByRole('button', { name: 'New customer' }));
    await userEvent.type(await view.findByLabelText(/^Phone/), '01712-345678');
    await userEvent.type(view.getByLabelText('Customer name', { exact: false }), 'Rina Akter');
    await userEvent.type(view.getByLabelText('Recipient name', { exact: false }), 'Rina Akter');
    await userEvent.type(view.getByLabelText(/^Address/), 'House 5, Road 3');
    await userEvent.type(view.getByLabelText('Thana / upazila', { exact: false }), 'Dhanmondi');
    await userEvent.type(view.getByLabelText('District', { exact: false }), 'Dhaka');
    await userEvent.type(view.getAllByLabelText('Add an item').at(-1)!, 'tee');
    await userEvent.click((await view.findAllByRole('button', { name: 'Add' })).at(-1)!);
    const qty = view.getAllByLabelText('Quantity (TEE-1)').at(-1)!;
    await userEvent.clear(qty);
    await userEvent.type(qty, '2');
    await userEvent.click(view.getAllByRole('button', { name: 'Confirm order' }).at(-1)!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const normalSent = (create.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
    const { idempotencyKey: a, ...fromDraft } = sent;
    const { idempotencyKey: b, ...fromForm } = normalSent;
    expect(a).not.toBe(b);
    expect(fromDraft).toEqual(fromForm);
    for (const forbidden of ['totalMinor', 'subtotalMinor', 'codAmountMinor', 'unitPriceMinor'])
      expect(JSON.stringify(sent)).not.toContain(forbidden);
  });

  it('reuses the same key when a failed confirm is tried again', async () => {
    const api = reviewApi(draft());
    api.socialDrafts.confirm
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ draft: draft(), order: order('again') });
    const { navigation } = mount(<SocialDraftScreen id={uuid(101)} />, api);
    await userEvent.type(
      await screen.findByLabelText('Thana / upazila', { exact: false }),
      'Mirpur',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    await waitFor(() => expect(api.socialDrafts.confirm).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm order' }));
    await waitFor(() => expect(api.socialDrafts.confirm).toHaveBeenCalledTimes(2));
    const calls = api.socialDrafts.confirm.mock.calls as unknown as [
      string,
      { idempotencyKey: string },
    ][];
    expect(calls[1]![1].idempotencyKey).toBe(calls[0]![1].idempotencyKey);
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/orders/again'));
  });

  it('says a draft was already closed, and reloads it', async () => {
    const api = reviewApi(draft());
    api.socialDrafts.confirm.mockRejectedValueOnce(new ApiError('closed', 409, 'draft_closed'));
    mount(<SocialDraftScreen id={uuid(101)} />, api);
    await userEvent.type(
      await screen.findByLabelText('Thana / upazila', { exact: false }),
      'Mirpur',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    expect(await screen.findByText(/already confirmed or dismissed/)).toBeTruthy();
    await waitFor(() => expect(api.socialDrafts.get.mock.calls.length).toBeGreaterThan(1));
  });

  it('saves only what the person changed, so the rest keeps its "check this" mark', async () => {
    const api = reviewApi(draft());
    mount(<SocialDraftScreen id={uuid(101)} />, api);
    const name = (await screen.findAllByDisplayValue('Rina Akter'))[0]!;
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Nothing new to save')).toBeTruthy();
    expect(api.socialDrafts.update).not.toHaveBeenCalled();
    await userEvent.clear(name);
    await userEvent.type(name, 'Rina A.');
    await userEvent.click(screen.getByLabelText('Increase Quantity (TEE-1)'));
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.socialDrafts.update).toHaveBeenCalledTimes(1));
    const [, patch] = (
      api.socialDrafts.update.mock.calls as unknown as [string, Record<string, unknown>][]
    )[0]!;
    expect(patch).toEqual({
      customerName: 'Rina A.',
      items: [{ variantId, text: 'Cotton tee — Red / M', quantity: 3 }],
    });
  });

  it('fills the thana and postal code from the draft, marks a doubtful area, and saves edits to them', async () => {
    const d = draft({
      fields: {
        ...draft().fields,
        area: field('Mirpur', 0.4),
        postalCode: field('1216', 0.9),
      },
    });
    const api = reviewApi(d);
    mount(<SocialDraftScreen id={uuid(101)} />, api);
    const area = await screen.findByDisplayValue('Mirpur');
    expect(area).toHaveAccessibleDescription(/Check this/);
    const postal = screen.getByDisplayValue('1216');
    expect(postal).not.toHaveAccessibleDescription(/Check this/);
    await userEvent.clear(area);
    await userEvent.type(area, 'Uttara');
    await userEvent.clear(postal);
    await userEvent.type(postal, '1230');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.socialDrafts.update).toHaveBeenCalledTimes(1));
    const [, patch] = (
      api.socialDrafts.update.mock.calls as unknown as [string, Record<string, unknown>][]
    )[0]!;
    expect(patch).toEqual({ area: 'Uttara', postalCode: '1230' });
  });

  it('does not save a half-typed postal code', async () => {
    const api = reviewApi(draft());
    mount(<SocialDraftScreen id={uuid(101)} />, api);
    await userEvent.type(await screen.findByLabelText('Postal code'), '12');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Nothing new to save')).toBeTruthy();
    expect(api.socialDrafts.update).not.toHaveBeenCalled();
  });

  it('dismisses with a reason that may be left empty', async () => {
    const api = reviewApi(draft());
    mount(<SocialDraftScreen id={uuid(101)} />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss draft' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Reason (optional)')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dismiss draft' }));
    await waitFor(() =>
      expect(api.socialDrafts.dismiss).toHaveBeenCalledWith(uuid(101), undefined),
    );
    expect(await screen.findByText('Draft dismissed')).toBeTruthy();
  });

  it('sends the reason when one is typed', async () => {
    const api = reviewApi(draft());
    mount(<SocialDraftScreen id={uuid(101)} />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss draft' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Reason (optional)'), 'Spam');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dismiss draft' }));
    await waitFor(() => expect(api.socialDrafts.dismiss).toHaveBeenCalledWith(uuid(101), 'Spam'));
  });

  it('shows a confirmed draft read-only with a link to its order', async () => {
    const d = draft({
      status: 'confirmed',
      orderId: uuid(777),
      orderNumber: 1001,
      reviewedAt: NOW,
    });
    mount(<SocialDraftScreen id={uuid(101)} />, reviewApi(d));
    expect(await screen.findByText('This draft was confirmed')).toBeTruthy();
    expect(screen.getByText('Order #1001')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the order' })).toHaveAttribute(
      'href',
      `/orders/${uuid(777)}`,
    );
    expect(screen.queryByRole('button', { name: 'Confirm order' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Cotton tee — Red / M × 2')).toBeTruthy();
  });

  it('shows a dismissed draft with the reason, read-only', async () => {
    const d = draft({ status: 'dismissed', dismissedReason: 'Spam', reviewedAt: NOW });
    mount(<SocialDraftScreen id={uuid(101)} />, reviewApi(d));
    expect(await screen.findByText('This draft was dismissed')).toBeTruthy();
    expect(screen.getByText('Spam')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm order' })).toBeNull();
  });

  it('shows an accountant the facts, the duplicates and no way to confirm', async () => {
    const d = draft({
      duplicates: [
        {
          orderId: uuid(900),
          orderNumber: 1042,
          status: 'confirmed',
          createdAt: NOW,
          totalMinor: 100,
          reasons: [],
        },
      ],
    });
    mount(<SocialDraftScreen id={uuid(101)} />, reviewApi(d), 'ACCOUNTANT');
    expect(await screen.findByText(/can look at drafts but not confirm or dismiss/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Order #1042' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm order' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss draft' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(
      screen.getByText('+8801712345678'.replace('+88', '').replace(/^(\d{5})/, '$1-')),
    ).toBeTruthy();
  });
});
