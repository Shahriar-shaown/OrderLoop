import { ApiError } from '@orderloop/api-client';
import type {
  Analytics,
  Dashboard,
  FinanceSummary,
  OrderPage,
  OutstandingCod,
  ShipmentSummary,
} from '@orderloop/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../../test/mount';
import { DashboardScreen } from './DashboardScreen';

const zeros = {
  pending_confirmation: 0,
  confirmed: 0,
  ready_to_ship: 0,
  shipped: 0,
  in_transit: 0,
  delivered: 0,
  delivery_failed: 0,
  cancelled: 0,
  return_requested: 0,
  returned: 0,
};
const data = (over: Partial<Dashboard> = {}): Dashboard => ({
  period: '7d',
  from: '2026-10-12',
  to: '2026-10-18',
  timezone: 'Asia/Dhaka',
  generatedAt: '2026-10-18T06:00:00.000Z',
  orders: { total: 0, byStatus: zeros },
  attention: { pendingConfirmation: 0, toShip: 0, deliveryFailed: 0, returnsOpen: 0 },
  delivery: {
    inProgress: 0,
    delivered: 0,
    failed: 0,
    returnsOpen: 0,
    returned: 0,
    successRate: null,
  },
  sales: {
    orderedMinor: 0,
    deliveredMinor: 0,
    codOutForDeliveryMinor: 0,
    ordersCounted: 0,
    averageOrderMinor: null,
  },
  daily: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-10-${12 + i}`,
    orders: 0,
    orderedMinor: 0,
  })),
  lowStock: { count: 0, items: [] },
  profit: {
    available: false,
    reason: 'No delivered orders in this period yet.',
    linesWithCost: 0,
    lines: 0,
  },
  recentActivity: [],
  ...over,
});

const busy = data({
  orders: { total: 6, byStatus: { ...zeros, pending_confirmation: 2, delivered: 3, cancelled: 1 } },
  attention: { pendingConfirmation: 2, toShip: 0, deliveryFailed: 1, returnsOpen: 0 },
  delivery: {
    inProgress: 0,
    delivered: 3,
    failed: 1,
    returnsOpen: 0,
    returned: 0,
    successRate: 0.75,
  },
  sales: {
    orderedMinor: 720_000,
    deliveredMinor: 300_000,
    codOutForDeliveryMinor: 70_000,
    ordersCounted: 5,
    averageOrderMinor: 144_000,
  },
  daily: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-10-${12 + i}`,
    orders: i === 6 ? 5 : 0,
    orderedMinor: i === 6 ? 720_000 : 0,
  })),
  lowStock: {
    count: 7,
    items: [
      {
        variantId: '0197b0a0-0000-7000-8000-0000000000a1',
        sku: 'LOW-1',
        productName: 'Low item',
        variantName: '',
        available: 0,
        reorderPoint: 5,
      },
    ],
  },
  profit: {
    available: true,
    kind: 'estimate',
    basis:
      'Item revenue minus the cost price. Leaves out order discounts, delivery charges, courier fees, returns and taxes.',
    revenueMinor: 300_000,
    costMinor: 120_000,
    grossProfitMinor: 180_000,
    deliveredOrders: 3,
    lines: 3,
  },
  recentActivity: [
    {
      id: '0197b0a0-0000-7000-8000-0000000000e1',
      at: '2026-10-18T05:00:00.000Z',
      orderId: '0197b0a0-0000-7000-8000-0000000000f1',
      orderNumber: 1006,
      fromStatus: 'shipped',
      toStatus: 'delivered',
      actorName: 'Anwar',
      reason: null,
    },
  ],
});

const outstanding: OutstandingCod = {
  asOf: '2026-10-18T06:00:00.000Z',
  deliveredExpectedMinor: 500_000,
  deliveredCollectedMinor: 380_000,
  outstandingMinor: 118_450,
  onTheWayMinor: 70_000,
  untrackedDeliveredCount: 0,
  untrackedDeliveredMinor: 0,
  byProvider: [],
  rows: [],
  truncated: false,
};
const summary = (profit: number | null): FinanceSummary => ({
  from: '2026-10-12',
  to: '2026-10-18',
  timezone: 'Asia/Dhaka',
  figures: [],
  manualCostsByKind: [],
  estimatedProfitMinor: profit,
  profitWithheldReason:
    profit === null ? '1 delivered line has no cost price, so profit cannot be worked out.' : null,
  caveats: [],
});
const analytics: Analytics = {
  from: '2026-10-12',
  to: '2026-10-18',
  timezone: 'Asia/Dhaka',
  daily: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-10-${12 + i}`,
    revenueMinor: i === 6 ? 300_000 : 0,
    grossProfitMinor: i === 6 ? 180_000 : 0,
  })),
  channels: [],
  topProducts: [],
  totalUnits: 0,
  totalRevenueMinor: 300_000,
  totalCostMinor: 120_000,
  deliveredOrders: 3,
  placedOrders: 5,
  placedMinor: 720_000,
  notDeliveredMinor: 420_000,
  averageOrderMinor: 100_000,
  deliverySuccessRate: 0.75,
  statusCounts: {},
  linesWithoutCost: 0,
};
const stats: ShipmentSummary = {
  recentDays: 14,
  statsDays: 30,
  bookedToday: 0,
  awaitingPickup: 0,
  onTheWay: 2,
  delayed: 0,
  delivered: 9,
  returned: 1,
  codOnTheWayMinor: 0,
  codOnTheWayCount: 0,
  providers: [
    {
      provider: 'pathao',
      simulated: false,
      shipments: 8,
      delivered: 7,
      deliveredRate: 0.875,
      avgDeliveryDays: 2.1,
    },
  ],
};
const recent: OrderPage = {
  items: [
    {
      id: '0197b0a0-0000-7000-8000-0000000000f1',
      orderNumber: 1006,
      status: 'delivered',
      source: 'facebook',
      customerId: '0197b0a0-0000-7000-8000-0000000000c1',
      customerName: 'Sadia Islam',
      phone: '01611908712',
      district: 'Dhaka',
      itemCount: 2,
      totalMinor: 173_500,
      codAmountMinor: 173_500,
      createdAt: '2026-10-17T05:30:00.000Z',
      itemsSummary: 'Matte Lipstick Set ×2 +1',
      payment: 'cod_pending',
      courier: { provider: 'pathao', simulated: false, status: 'delivered' },
    },
  ],
  nextCursor: null,
  total: 1,
  statusCounts: {},
};

/** The API the screen reads, with sensible answers; pass overrides to change one. */
const api = (dash: unknown, over: Record<string, unknown> = {}) => ({
  dashboard: { get: typeof dash === 'function' ? dash : async () => dash },
  finance: {
    outstanding: async () => outstanding,
    summary: async () => summary(180_000),
    analytics: async () => analytics,
    ...(over.finance as object),
  },
  shipments: { stats: async () => stats },
  orders: { list: async () => recent },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'finance')),
});

describe('dashboard', () => {
  it('shows a loading state, then the figures from the API', async () => {
    let release!: (d: Dashboard) => void;
    const get = vi.fn(() => new Promise<Dashboard>((r) => (release = r)));
    mount(<DashboardScreen />, api(get));
    expect(await screen.findByLabelText('Loading the dashboard')).toBeTruthy();
    release(busy);
    expect(await screen.findByRole('group', { name: 'Total orders: 6' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Delivered orders: 3' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Delivery success: 75%' })).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Revenue \(delivered\): ৳3,000\.00/ })).toBeTruthy();
    expect(await screen.findByRole('group', { name: /^COD outstanding: ৳1,184\.50/ })).toBeTruthy();
    expect(await screen.findByRole('group', { name: /^Net profit: ৳1,800\.00/ })).toBeTruthy();
  });

  it('greets the signed-in person by first name, with the business name', async () => {
    mount(<DashboardScreen />, api(busy));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /^Good (morning|afternoon|evening), Anwar$/,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/· Shop$/)).toBeTruthy();
  });

  it('shows net profit as a dash with the reason when the API withholds it, and never invents a figure', async () => {
    mount(<DashboardScreen />, api(busy, { finance: { summary: async () => summary(null) } }));
    expect(await screen.findByText(/1 delivered line has no cost price/)).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Net profit: —/ })).toBeTruthy();
  });

  it('falls back to dashboard figures, and skips finance calls, for a role that cannot read finance', async () => {
    const outstandingFn = vi.fn(async () => outstanding);
    mount(<DashboardScreen />, api(busy, { finance: { outstanding: outstandingFn } }), 'STAFF');
    expect(
      await screen.findByRole('group', { name: /^Cash on delivery out: ৳700\.00/ }),
    ).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Average order: ৳1,440\.00/ })).toBeTruthy();
    expect(screen.queryByText('COD settlement')).toBeNull();
    expect(outstandingFn).not.toHaveBeenCalled();
  });

  it('draws the order status ring with a legend that links to the filtered orders', async () => {
    mount(<DashboardScreen />, api(busy));
    const link = await screen.findByRole('link', { name: 'Delivered' });
    expect(link.getAttribute('href')).toBe(
      '/orders?status=delivered&from=2026-10-12&to=2026-10-18',
    );
    expect(screen.getByText('3 · 50%')).toBeTruthy();
    expect(screen.getByRole('img', { name: /^Orders by status: .*Delivered 3/ })).toBeTruthy();
  });

  it('says what needs attention, with links to the filtered lists, and lists low stock', async () => {
    mount(<DashboardScreen />, api(busy));
    const link = await screen.findByRole('link', { name: '2 orders waiting to be confirmed' });
    expect(link.getAttribute('href')).toBe('/orders?status=pending_confirmation');
    expect(screen.getByText('Needs attention · 3 orders')).toBeTruthy();
    expect(screen.getByRole('link', { name: '1 failed delivery to follow up' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '7 products running low on stock' })).toBeTruthy();
    expect(screen.getByText('Low item')).toBeTruthy();
    expect(screen.getByText('0 left')).toBeTruthy();
    expect(screen.getByText('and 6 more')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Receive stock' }).getAttribute('href')).toBe(
      '/products',
    );
  });

  it('lists recent orders, courier performance and the COD settlement from the API', async () => {
    mount(<DashboardScreen />, api(busy));
    expect(await screen.findByRole('link', { name: '#1006' })).toBeTruthy();
    expect(screen.getByText('Sadia Islam')).toBeTruthy();
    expect(screen.getByText('COD · Pending')).toBeTruthy();
    expect((await screen.findAllByText('Pathao')).length).toBeGreaterThan(1); // the orders table and the courier card
    expect(screen.getByText('8 shipments · avg 2.1 days')).toBeTruthy();
    expect(screen.getByText('87.5%')).toBeTruthy();
    expect(await screen.findByText('Still with couriers')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reconcile' }).getAttribute('href')).toBe('/cod');
  });

  it('says so when there are no shipments yet', async () => {
    mount(
      <DashboardScreen />,
      api(busy, { shipments: { stats: async () => ({ ...stats, providers: [] }) } }),
    );
    expect(await screen.findByText(/No shipments yet/)).toBeTruthy();
  });

  it('welcomes a new business with next steps that are real links, and says nothing needs attention', async () => {
    mount(
      <DashboardScreen />,
      api(data(), { orders: { list: async () => ({ ...recent, items: [] }) } }),
    );
    expect(await screen.findByText('Welcome. Your dashboard fills in as you work.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add a product' }).getAttribute('href')).toBe(
      '/products/new',
    );
    expect(screen.getByRole('link', { name: 'Take an order' }).getAttribute('href')).toBe(
      '/orders/new',
    );
    expect(screen.getByText('Nothing needs your attention right now.')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Delivery success: —' })).toBeTruthy();
    expect(await screen.findByText('No orders yet')).toBeTruthy();
  });

  it('asks the server for the chosen period', async () => {
    const get = vi.fn(async () => busy);
    mount(<DashboardScreen />, api(get));
    await screen.findByRole('group', { name: 'Total orders: 6' });
    expect(get).toHaveBeenLastCalledWith('7d');
    await userEvent.click(screen.getByRole('tab', { name: 'Today' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('today'));
    await userEvent.click(screen.getByRole('tab', { name: '30 days' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('30d'));
    expect(screen.queryByRole('tab', { name: /custom/i })).toBeNull();
  });

  it('shows an error with a retry, then recovers', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Not allowed right now', 403, 'forbidden'))
      .mockResolvedValue(busy);
    mount(<DashboardScreen />, api(get));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    await userEvent.click(retry);
    expect(await screen.findByRole('group', { name: 'Total orders: 6' })).toBeTruthy();
  });

  it('offers Create order only to a role that can create orders', async () => {
    mount(<DashboardScreen />, api(busy), 'ACCOUNTANT');
    await screen.findByRole('group', { name: 'Total orders: 6' });
    expect(screen.queryByRole('link', { name: 'Create order' })).toBeNull();
  });
});
