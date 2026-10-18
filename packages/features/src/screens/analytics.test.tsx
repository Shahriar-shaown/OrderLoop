import { ApiError } from '@orderloop/api-client';
import type {
  Analytics,
  FinanceFigure,
  FinanceSummary,
  ManualCost,
  OutstandingCod,
} from '@orderloop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/mount';
import { AnalyticsScreen, productRows, waterfallSteps } from './AnalyticsScreen';

const fig = (
  key: string,
  group: FinanceFigure['group'],
  amountMinor: number,
  source: FinanceFigure['source'] = 'orders',
  label = key,
): FinanceFigure => ({ key, group, label, amountMinor, source, note: `Note for ${key}.` });

const figures = (withCogs = true): FinanceFigure[] => [
  fig('sales', 'sales', 286_400_00),
  fig('cancelled', 'sales', 5_000_00, 'orders', 'Cancelled orders (left out of sales)'),
  fig('revenue_goods', 'revenue', 200_000_00),
  fig('revenue_delivery', 'revenue', 13_000_00),
  ...(withCogs ? [fig('cogs', 'expenses', 130_950_00, 'catalog_costs')] : []),
  fig('courier_delivery', 'expenses', 8_160_00, 'settlements'),
  fig('courier_cod_fee', 'expenses', 1_350_00, 'settlements'),
  fig('courier_return', 'expenses', 2_100_00, 'settlements'),
  fig('courier_other', 'expenses', 100_00, 'settlements'),
  fig('manual_costs', 'expenses', 28_340_00, 'manual_costs'),
  fig('cod_written_off', 'expenses', 0, 'manual_costs'),
  ...(withCogs ? [fig('estimated_profit', 'profit', 42_000_00, 'derived')] : []),
];

const summary = (withCogs = true): FinanceSummary => ({
  from: '2026-10-12',
  to: '2026-10-18',
  timezone: 'Asia/Dhaka',
  figures: figures(withCogs),
  manualCostsByKind: [
    { kind: 'advertising', amountMinor: 24_000_00 },
    { kind: 'packaging', amountMinor: 4_340_00 },
  ],
  estimatedProfitMinor: withCogs ? 42_000_00 : null,
  profitWithheldReason: withCogs
    ? null
    : '3 delivered order lines have no cost price, so profit cannot be worked out.',
  caveats: ['Sales, revenue and profit are different things and are never added together.'],
});

const analytics = (over: Partial<Analytics> = {}): Analytics => ({
  from: '2026-10-12',
  to: '2026-10-18',
  timezone: 'Asia/Dhaka',
  daily: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-10-${12 + i}`,
    revenueMinor: i * 1_000_00,
    grossProfitMinor: i === 3 ? null : i * 400_00,
  })),
  channels: [
    { source: 'facebook', orders: 40, revenueMinor: 102_240_00 },
    { source: 'phone_call', orders: 10, revenueMinor: 21_300_00 },
  ],
  topProducts: [
    {
      productName: 'Cotton T-Shirt',
      variantName: 'M',
      sku: 'TS-M',
      units: 40,
      revenueMinor: 26_000_00,
      costMinor: 16_000_00,
      grossProfitMinor: 10_000_00,
    },
    {
      productName: 'Floral Three-piece',
      variantName: 'L',
      sku: 'FL-L',
      units: 8,
      revenueMinor: 26_320_00,
      costMinor: 17_200_00,
      grossProfitMinor: 9_120_00,
    },
  ],
  totalUnits: 170,
  totalRevenueMinor: 213_000_00,
  totalCostMinor: 130_950_00,
  deliveredOrders: 96,
  placedOrders: 124,
  placedMinor: 286_400_00,
  notDeliveredMinor: 73_400_00,
  averageOrderMinor: 2_218_75,
  deliverySuccessRate: 0.932,
  statusCounts: {},
  linesWithoutCost: 0,
  ...over,
});

const outstanding: OutstandingCod = {
  asOf: '2026-10-18T06:00:00.000Z',
  deliveredExpectedMinor: 0,
  deliveredCollectedMinor: 0,
  outstandingMinor: 118_450_00,
  onTheWayMinor: 45_850_00,
  untrackedDeliveredCount: 0,
  untrackedDeliveredMinor: 0,
  byProvider: [],
  rows: [],
  truncated: false,
};

const cost = (over: Partial<ManualCost> = {}): ManualCost => ({
  id: '0197b0a0-0000-7000-8000-0000000000d1',
  kind: 'advertising',
  amountMinor: 24_000_00,
  incurredOn: '2026-10-15',
  orderId: null,
  orderNumber: null,
  note: 'Facebook boost',
  voidedAt: null,
  voidReason: null,
  createdAt: '2026-10-15T05:00:00.000Z',
  ...over,
});

const api = (
  over: { summary?: FinanceSummary; analytics?: Analytics; costs?: ManualCost[] } = {},
) => ({
  finance: {
    summary: vi.fn(async () => over.summary ?? summary()),
    analytics: vi.fn<(q: { from: string; to: string }) => Promise<Analytics>>(
      async () => over.analytics ?? analytics(),
    ),
    outstanding: async () => outstanding,
    costs: async () => over.costs ?? [cost()],
    createCost: vi.fn(async () => cost()),
    voidCost: vi.fn(async () => undefined),
  },
});

describe('analytics and profit', () => {
  it('shows the figures from the API, each with where it comes from', async () => {
    mount(<AnalyticsScreen />, api());
    const gross = await screen.findByRole('group', { name: /^Gross sales: ৳2,86,400\.00/ });
    expect(within(gross).getByText('all 124 orders')).toBeTruthy();
    expect(within(gross).getByText('From your orders')).toBeTruthy();
    const revenue = screen.getByRole('group', { name: /^Delivered revenue: ৳2,13,000\.00/ });
    expect(within(revenue).getByText('96 orders')).toBeTruthy();
    const profit = screen.getByRole('group', { name: /^Net profit: ৳42,000\.00/ });
    expect(within(profit).getByText('Worked out from the figures above')).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Profit margin: 19\.7%/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Avg order value: ৳2,218\.75/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Delivery success: 93\.2%/ })).toBeTruthy();
  });

  it('lays out how profit is calculated with each cost as a share of revenue, and names its source', async () => {
    mount(<AnalyticsScreen />, api());
    await screen.findByText('How profit is calculated');
    expect(screen.getByText('Product cost (61.5%)')).toBeTruthy();
    expect(screen.getAllByText('−৳1,30,950.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Courier delivery charges (3.8%)')).toBeTruthy();
    expect(screen.getByText('Advertising (11.3%)')).toBeTruthy();
    expect(screen.getByText('Total costs')).toBeTruthy();
    expect(screen.getByText('Net profit · margin 19.7%')).toBeTruthy();
    expect(screen.getAllByText('From courier statements').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Entered by hand').length).toBeGreaterThan(0);
    // the notes behind the figures are one click away
    expect(screen.queryByText(/Note for cogs/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'What each figure counts' }));
    expect(await screen.findByText(/Note for cogs\./)).toBeTruthy();
  });

  it('says what is not counted as profit', async () => {
    mount(<AnalyticsScreen />, api());
    expect(await screen.findByText('Not counted as profit')).toBeTruthy();
    expect(await screen.findByText('৳1,18,450.00')).toBeTruthy();
    expect(screen.getByText('COD still with couriers')).toBeTruthy();
    expect(screen.getByText('৳73,400.00')).toBeTruthy();
    expect(screen.getByText(/Unsettled COD is cash still to arrive, not earnings/)).toBeTruthy();
  });

  it('withholds profit, with the reason, instead of drawing a fake result', async () => {
    mount(
      <AnalyticsScreen />,
      api({ summary: summary(false), analytics: analytics({ linesWithoutCost: 3 }) }),
    );
    expect(await screen.findByText('3 delivered lines have no cost price')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Fix costs' }).getAttribute('href')).toBe('/products');
    expect(screen.getByRole('group', { name: /^Net profit: —/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Profit margin: —/ })).toBeTruthy();
    expect(screen.getByText('Net profit is not shown')).toBeTruthy();
    expect(screen.queryByText('Total costs')).toBeNull();
    expect(screen.queryByText(/^Net profit · margin/)).toBeNull();
    const chart = screen.getByRole('img', { name: /^Profit waterfall/ });
    expect(chart.getAttribute('aria-label')).toMatch(/Delivered revenue ৳2,13,000\.00$/);
  });

  it('draws the waterfall from gross sales to net profit', () => {
    const s = summary();
    const steps = waterfallSteps(s, analytics(), [
      { key: 'cogs', label: 'Product cost', amountMinor: 130_950_00 },
      { key: 'ads', label: 'Advertising', amountMinor: 24_000_00 },
    ]);
    expect(steps.map((x) => `${x.label}:${x.kind}:${x.value}`)).toEqual([
      'Gross sales:total:28640000',
      'Not delivered:minus:7340000',
      'Delivered revenue:total:21300000',
      'Product cost:minus:13095000',
      'Ad spend:minus:2400000',
      'Net profit:total:4200000',
    ]);
  });

  it('adds up other products and the total under the top products', () => {
    const rows = productRows(analytics());
    expect(rows.map((r) => r.name)).toEqual([
      'Cotton T-Shirt — M',
      'Floral Three-piece — L',
      'Other products',
      'Total · delivered',
    ]);
    const other = rows[2]!;
    expect(other.units).toBe(122);
    expect(other.revenue).toBe(213_000_00 - 26_000_00 - 26_320_00);
    expect(other.cost).toBe(130_950_00 - 16_000_00 - 17_200_00);
    expect(rows[3]!.profit).toBe(82_050_00);
    // an unknown cost anywhere means the rest cannot be known either
    const unknown = productRows(analytics({ totalCostMinor: null }));
    expect(unknown[2]!.cost).toBeNull();
    expect(unknown[3]!.profit).toBeNull();
  });

  it('shows channels and best sellers', async () => {
    mount(<AnalyticsScreen />, api());
    expect(await screen.findByText('Facebook')).toBeTruthy();
    expect(screen.getByText('Phone call')).toBeTruthy();
    expect(screen.getByText('82.8%')).toBeTruthy();
    expect(screen.getByText('Cotton T-Shirt — M')).toBeTruthy();
    expect(screen.getByText('Other products')).toBeTruthy();
    expect(screen.getByText('Total · delivered')).toBeTruthy();
  });

  it('shows the caveats from the API', async () => {
    mount(<AnalyticsScreen />, api());
    expect(await screen.findByText('Read this before you trust the figures')).toBeTruthy();
    expect(screen.getByText(/never added together/)).toBeTruthy();
  });

  it('asks the API for the chosen period', async () => {
    const a = api();
    mount(<AnalyticsScreen />, a);
    await screen.findByText('How profit is calculated');
    const first = a.finance.analytics.mock.calls.at(-1)![0];
    expect(first.to > first.from).toBe(true);
    await userEvent.click(screen.getByRole('tab', { name: 'Today' }));
    await waitFor(() => {
      const last = a.finance.analytics.mock.calls.at(-1)![0];
      expect(last.from).toBe(last.to);
    });
    expect(screen.queryByRole('tab', { name: /custom/i })).toBeNull();
  });

  it('lists recorded costs and lets a role that can adjust finance record and void one', async () => {
    const a = api();
    mount(<AnalyticsScreen />, a);
    expect(await screen.findByText('Facebook boost')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Record a cost' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Void' }));
    await userEvent.type(screen.getByLabelText(/Reason/), 'Entered twice');
    await userEvent.click(screen.getByRole('button', { name: 'Void cost' }));
    await waitFor(() =>
      expect(a.finance.voidCost).toHaveBeenCalledWith(cost().id, 'Entered twice'),
    );
  });

  it('hides the cost buttons from a role that can only read finance', async () => {
    mount(<AnalyticsScreen />, api(), 'MANAGER');
    expect(await screen.findByText('Facebook boost')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record a cost' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
  });

  it('shows an error with a retry', async () => {
    const a = api();
    a.finance.summary.mockRejectedValueOnce(
      new ApiError('Not allowed right now', 403, 'forbidden'),
    );
    mount(<AnalyticsScreen />, a);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('How profit is calculated')).toBeTruthy();
  });

  it('does not show finance figures to a role without finance access', async () => {
    mount(<AnalyticsScreen />, api(), 'STAFF');
    expect(await screen.findByText('Finance figures are not available to your role')).toBeTruthy();
  });
});
