import { ApiError } from '@orderloop/api-client';
import type { Dashboard } from '@orderloop/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/mount';
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

describe('dashboard', () => {
  it('shows a loading state, then the backend’s figures', async () => {
    let release!: (d: Dashboard) => void;
    const get = vi.fn(() => new Promise<Dashboard>((r) => (release = r)));
    mount(<DashboardScreen />, { dashboard: { get } });
    expect(await screen.findByLabelText('Loading the dashboard')).toBeTruthy();
    release(busy);
    expect(await screen.findByRole('group', { name: 'Orders: 6' })).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Sales: ৳7,200\.00/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Average order: ৳1,440\.00/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Delivery success: 75%' })).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Cash on delivery out: ৳700\.00/ })).toBeTruthy();
  });

  it('says what needs attention, with links to the filtered lists, and lists low stock', async () => {
    mount(<DashboardScreen />, { dashboard: { get: async () => busy } });
    const link = await screen.findByRole('link', { name: '2 orders waiting to be confirmed' });
    expect(link.getAttribute('href')).toBe('/orders?status=pending_confirmation');
    expect(screen.getByRole('link', { name: '1 failed delivery to follow up' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '7 products running low on stock' })).toBeTruthy();
    expect(screen.getByText('Low item')).toBeTruthy();
    expect(screen.getByText('and 6 more')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Order #1006' })).toBeTruthy();
  });

  it('labels profit as an estimate and shows how it was worked out', async () => {
    mount(<DashboardScreen />, { dashboard: { get: async () => busy } });
    expect(await screen.findByText('Estimate')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Estimated gross profit: ৳1,800.00' })).toBeTruthy();
    expect(
      screen.getByText(
        /Leaves out order discounts, delivery charges, courier fees, returns and taxes/,
      ),
    ).toBeTruthy();
  });

  it('shows no profit figure at all when it cannot be worked out, and says why', async () => {
    const d = data({
      profit: {
        available: false,
        reason:
          '1 of 2 delivered order lines have no cost price, so profit cannot be worked out. Add cost prices to your products.',
        linesWithCost: 1,
        lines: 2,
      },
    });
    mount(<DashboardScreen />, { dashboard: { get: async () => d } });
    expect(await screen.findByText(/1 of 2 delivered order lines have no cost price/)).toBeTruthy();
    expect(screen.queryByText('Estimate')).toBeNull();
    expect(screen.queryByText(/Estimated gross profit/)).toBeNull();
  });

  it('welcomes a new business with next steps that are real links, and says nothing needs attention', async () => {
    mount(<DashboardScreen />, { dashboard: { get: async () => data() } });
    expect(await screen.findByText('Welcome. Your dashboard fills in as you work.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add a product' }).getAttribute('href')).toBe(
      '/products/new',
    );
    expect(screen.getByRole('link', { name: 'Take an order' }).getAttribute('href')).toBe(
      '/orders/new',
    );
    expect(screen.getByText('Nothing needs your attention right now.')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Average order: —' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Delivery success: —' })).toBeTruthy();
  });

  it('describes each chart in words for screen readers, with the real numbers', async () => {
    mount(<DashboardScreen />, { dashboard: { get: async () => busy } });
    const chart = await screen.findByRole('img', { name: /^Orders per day/ });
    expect(chart.getAttribute('aria-label')).toMatch(/Oct 18 5\.$/);
    expect(screen.getByRole('img', { name: /^Sales per day.*Oct 18 ৳7,200\.00\.$/ })).toBeTruthy();
  });

  it('asks the server for the chosen period', async () => {
    const get = vi.fn(async () => busy);
    mount(<DashboardScreen />, { dashboard: { get } });
    await screen.findByRole('group', { name: 'Orders: 6' });
    expect(get).toHaveBeenLastCalledWith('7d');
    await userEvent.click(screen.getByRole('tab', { name: 'Today' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('today'));
    await userEvent.click(screen.getByRole('tab', { name: 'Last 30 days' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('30d'));
  });

  it('shows an error with a retry, then recovers', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Not allowed right now', 403, 'forbidden'))
      .mockResolvedValue(busy);
    mount(<DashboardScreen />, { dashboard: { get } });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    await userEvent.click(retry);
    expect(await screen.findByRole('group', { name: 'Orders: 6' })).toBeTruthy();
  });

  it('offers New order only to a role that can create orders', async () => {
    mount(<DashboardScreen />, { dashboard: { get: async () => busy } }, 'ACCOUNTANT');
    await screen.findByRole('group', { name: 'Orders: 6' });
    expect(screen.queryByRole('link', { name: 'New order' })).toBeNull();
  });
});
