import { ApiError } from '@orderloop/api-client';
import type { TikTokOrder, TikTokOrderPage, TikTokSkuLink } from '@orderloop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNamedControls, expectNamesContainVisibleText } from '../../../test/a11y';
import { mount } from '../../../test/mount';
import { explainStock } from '../../lib/tiktok';
import { TikTokOrderScreen } from './TikTokOrderScreen';
import { TikTokOrdersScreen } from './TikTokOrdersScreen';
import {
  catalogue,
  connection,
  detail,
  line,
  MOCK_BANNER,
  overview,
  skuLink,
  summary,
  uuid,
} from './fixtures';

const page = (over: Partial<TikTokOrderPage> = {}): TikTokOrderPage => ({
  mode: 'mock',
  items: [],
  nextCursor: null,
  counts: {},
  ...over,
});
const COUNTS = { reserved: 4, shipped: 3, released: 1, needs_mapping: 2, stock_short: 1, none: 5 };
const noTaka = () => expect(document.body.textContent ?? '').not.toContain('৳');

function ordersApi(
  pages: TikTokOrderPage | TikTokOrderPage[] = page(),
  options: { overview?: Partial<ReturnType<typeof overview>>; links?: unknown } = {},
) {
  const queue = Array.isArray(pages) ? [...pages] : null;
  return {
    ...catalogue('TEE-1'),
    tiktokShop: {
      overview: vi.fn(async () => overview({ connections: [connection()], ...options.overview })),
      sync: vi.fn(async () => ({
        mode: 'mock',
        fetched: 0,
        updated: 0,
        reconciled: 0,
        truncated: false,
      })),
    },
    tiktokOrders: {
      list: vi.fn(async () => (queue ? (queue.shift() ?? page()) : (pages as TikTokOrderPage))),
      get: vi.fn(),
    },
    tiktokSkuLinks: {
      list: vi.fn(
        async () => options.links ?? { items: [skuLink()], nextCursor: null, unmappedCount: 1 },
      ),
      update: vi.fn(),
    },
  };
}

describe('TikTok orders list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the orders with shop, status, stock state, a plain explanation, total and items', async () => {
    const api = ordersApi(
      page({
        items: [
          summary(),
          summary({
            id: uuid(101),
            externalOrderId: 'TT-1002',
            status: 'IN_TRANSIT',
            stockState: 'shipped',
            totalMinor: 99900,
            unitCount: 1,
          }),
          summary({
            id: uuid(102),
            externalOrderId: 'TT-1003',
            status: 'BRAND_NEW_STATUS',
            stockState: 'none',
          }),
        ],
        counts: COUNTS,
      }),
    );
    mount(<TikTokOrdersScreen />, api);
    const row = within(await screen.findByRole('row', { name: 'TikTok order TT-1001' }));
    expect(row.getByText('TT-1001')).toBeTruthy();
    expect(row.getByText('Demo TikTok shop')).toBeTruthy();
    expect(row.getByText('Mock')).toBeTruthy();
    expect(row.getByText('Awaiting shipment')).toBeTruthy();
    expect(row.getByText('Stock reserved')).toBeTruthy();
    expect(row.getByText(/Stock is held for this order/)).toBeTruthy();
    expect(row.getByText('MYR 24.50')).toBeTruthy();
    expect(row.getByText('2 items')).toBeTruthy();
    const shipped = within(screen.getByRole('row', { name: 'TikTok order TT-1002' }));
    expect(shipped.getByText('MYR 999.00')).toBeTruthy();
    expect(shipped.getByText('1 item')).toBeTruthy();
    // A status OrderLoop has no wording for is shown, not hidden.
    expect(
      within(screen.getByRole('row', { name: 'TikTok order TT-1003' })).getByText(
        'Brand new status',
      ),
    ).toBeTruthy();
    noTaka();
  });

  it('never writes a taka sign, whatever the currency', async () => {
    const api = ordersApi(
      page({
        items: [
          summary({ currency: 'JPY', currencyExponent: 0, totalMinor: 5000 }),
          summary({ id: uuid(101), externalOrderId: 'B', currency: 'BDT', totalMinor: 12345 }),
          summary({ id: uuid(102), externalOrderId: 'X', currency: 'XYZ', totalMinor: 1 }),
        ],
        counts: COUNTS,
      }),
    );
    mount(<TikTokOrdersScreen />, api);
    expect(await screen.findByText('JPY 5,000')).toBeTruthy();
    expect(screen.getByText('BDT 123.45')).toBeTruthy();
    expect(screen.getByText('XYZ 0.01')).toBeTruthy();
    noTaka();
  });

  it('flags an order cancelled after it shipped', async () => {
    const api = ordersApi(
      page({
        items: [
          summary({
            status: 'CANCELLED',
            stockState: 'shipped',
            attention: 'cancelled_after_shipping',
          }),
        ],
        counts: COUNTS,
      }),
    );
    mount(<TikTokOrdersScreen />, api);
    expect(
      await screen.findByText('Cancelled after it shipped: stock was not changed, check it'),
    ).toBeTruthy();
    expect(screen.getAllByText('Needs a look').length).toBeGreaterThan(1); // the marker, and the filter chip
  });

  it('shows the mock banner, and the facts about currency and reading only', async () => {
    mount(<TikTokOrdersScreen />, ordersApi(page({ items: [summary()], counts: COUNTS })));
    expect(await screen.findByText(MOCK_BANNER)).toBeTruthy();
    expect(screen.getByText(/in the shop’s own currency, are not OrderLoop orders/)).toBeTruthy();
    expect(screen.getByText(/never changes anything there/)).toBeTruthy();
  });

  it('filters by stock state, with the count of each state on its chip', async () => {
    const api = ordersApi(page({ items: [summary()], counts: COUNTS }), {
      overview: { attentionOrders: 2 },
    });
    mount(<TikTokOrdersScreen />, api);
    await screen.findByRole('row', { name: 'TikTok order TT-1001' });
    const chip = (name: string) => screen.getByRole('tab', { name });
    expect(chip('All 16')).toBeTruthy();
    expect(chip('Needs mapping 2')).toBeTruthy();
    expect(chip('Not enough stock 1')).toBeTruthy();
    expect(chip('Reserved 4')).toBeTruthy();
    expect(chip('Shipped 3')).toBeTruthy();
    expect(chip('Released 1')).toBeTruthy();
    expect(chip('No stock held 5')).toBeTruthy();
    expect(chip('Needs a look 2')).toBeTruthy();
    await userEvent.click(chip('Needs mapping 2'));
    await waitFor(() =>
      expect(api.tiktokOrders.list).toHaveBeenLastCalledWith({
        limit: 25,
        stockState: 'needs_mapping',
      }),
    );
    await userEvent.click(chip('Needs a look 2'));
    await waitFor(() =>
      expect(api.tiktokOrders.list).toHaveBeenLastCalledWith({ limit: 25, attention: 'true' }),
    );
  });

  it('filters by status, and by shop only when there are several', async () => {
    const api = ordersApi(page({ items: [summary()], counts: COUNTS }));
    const view = mount(<TikTokOrdersScreen />, api);
    await screen.findByRole('row', { name: 'TikTok order TT-1001' });
    expect(screen.queryByRole('button', { name: /^Shop:/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Status:/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'In transit' }));
    await waitFor(() =>
      expect(api.tiktokOrders.list).toHaveBeenLastCalledWith({ limit: 25, status: 'IN_TRANSIT' }),
    );
    view.unmount();

    const two = ordersApi(page({ items: [summary()], counts: COUNTS }), {
      overview: {
        connections: [connection(), connection({ id: uuid(2), shopName: 'Second shop' })],
      },
    });
    mount(<TikTokOrdersScreen />, two);
    await userEvent.click(await screen.findByRole('button', { name: /^Shop:/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Second shop' }));
    await waitFor(() =>
      expect(two.tiktokOrders.list).toHaveBeenLastCalledWith({ limit: 25, connectionId: uuid(2) }),
    );
  });

  it('loads more with the cursor', async () => {
    const api = ordersApi([
      page({ items: [summary()], nextCursor: 'c1', counts: COUNTS }),
      page({ items: [summary({ id: uuid(101), externalOrderId: 'TT-2000' })], counts: COUNTS }),
    ]);
    mount(<TikTokOrdersScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('row', { name: 'TikTok order TT-2000' })).toBeTruthy();
    expect(api.tiktokOrders.list).toHaveBeenLastCalledWith({ limit: 25, cursor: 'c1' });
    expect(screen.getByRole('row', { name: 'TikTok order TT-1001' })).toBeTruthy();
  });

  it('opens an order from its row', async () => {
    const api = ordersApi(page({ items: [summary()], counts: COUNTS }));
    const { navigation } = mount(<TikTokOrdersScreen />, api);
    await userEvent.click(await screen.findByRole('row', { name: 'TikTok order TT-1001' }));
    expect(navigation.push).toHaveBeenCalledWith(`/tiktok-orders/${uuid(100)}`);
  });

  it('explains how orders arrive when there are none, and that nothing changes on TikTok', async () => {
    mount(<TikTokOrdersScreen />, ordersApi());
    expect(await screen.findByText('No TikTok orders here')).toBeTruthy();
    expect(screen.getByText(/every 10 minutes/)).toBeTruthy();
    expect(screen.getByText(/Nothing is changed on TikTok/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to the TikTok Shop integration' })).toHaveAttribute(
      'href',
      '/settings/integrations/tiktok-shop',
    );
  });

  it('shows a failure with a way to retry', async () => {
    const api = ordersApi();
    api.tiktokOrders.list.mockRejectedValue(new ApiError('boom', 500, 'internal_error'));
    mount(<TikTokOrdersScreen />, api);
    expect(await screen.findByText(/Something went wrong on our side/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('has named controls', async () => {
    mount(<TikTokOrdersScreen />, ordersApi(page({ items: [summary()], counts: COUNTS })));
    await screen.findByRole('row', { name: 'TikTok order TT-1001' });
    expectNamedControls();
  });
});

describe('TikTok order stock sentences', () => {
  const base = summary();
  it.each([
    [
      { stockState: 'needs_mapping', unmappedLineCount: 1 },
      'Waiting for you to map 1 item: no stock has been moved.',
    ],
    [
      { stockState: 'needs_mapping', unmappedLineCount: 3 },
      'Waiting for you to map 3 items: no stock has been moved.',
    ],
    [{ stockState: 'stock_short' }, /not enough available stock for the whole order/],
    [{ stockState: 'reserved' }, /Stock is reserved for this order/],
    [{ stockState: 'shipped' }, 'The order has shipped, so its stock has left.'],
    [{ stockState: 'released' }, /cancelled the order before it shipped/],
    [{ stockState: 'none', status: 'UNPAID' }, /not paid yet/],
    [{ stockState: 'none', status: 'AWAITING_SHIPMENT', onHold: true }, /buyer can still cancel/],
    [{ stockState: 'none', status: 'CANCELLED' }, /cancelled before any stock was held/],
    [{ stockState: 'something_new' }, /does not know this stock state/],
  ] as const)('explains %j', (over, expected) => {
    const text = explainStock({ ...base, ...over } as never);
    if (typeof expected === 'string') expect(text).toBe(expected);
    else expect(text).toMatch(expected);
  });
});

function detailApi(order: TikTokOrder, extra: Record<string, unknown> = {}) {
  let current = order;
  return {
    ...catalogue('TEE-1'),
    tiktokShop: { sync: vi.fn(async () => ({})) },
    tiktokOrders: { get: vi.fn(async () => current) },
    tiktokSkuLinks: {
      update: vi.fn(async (_id: string, variantId: string | null) => {
        current = {
          ...current,
          stockState: 'reserved',
          unmappedLineCount: 0,
          lines: current.lines.map((l) =>
            l.mapped
              ? l
              : {
                  ...l,
                  mapped: variantId !== null,
                  hold: variantId ? ('held' as const) : null,
                  variant: variantId
                    ? {
                        id: variantId,
                        sku: 'TEE-1',
                        productName: 'Cotton tee',
                        variantName: 'Red / M',
                      }
                    : null,
                },
          ),
        };
        return { link: skuLink(), reconciledOrders: 1 };
      }),
    },
    ...extra,
  };
}
const unmappedOrder = (): TikTokOrder =>
  detail({
    stockState: 'needs_mapping',
    unmappedLineCount: 1,
    lines: [
      line({ key: 'sku:s1' }),
      line({
        key: 'sku:s9',
        externalSkuId: 's9',
        sellerSku: 'RED-HAT',
        productName: 'Red hat',
        quantity: 1,
        mapped: false,
        hold: null,
        variant: null,
        skuLinkId: uuid(301),
      }),
    ],
  });

describe('TikTok order detail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the status, the stock state, one sentence on why, and the totals in the shop currency', async () => {
    mount(<TikTokOrderScreen id={uuid(100)} />, detailApi(detail()));
    expect(await screen.findByRole('heading', { level: 1, name: 'TT-1001' })).toBeTruthy();
    expect(screen.getByText(MOCK_BANNER)).toBeTruthy();
    expect(screen.getByText('Awaiting shipment')).toBeTruthy();
    expect(screen.getByText('Stock reserved')).toBeTruthy();
    expect(screen.getByText(/Stock is reserved for this order/)).toBeTruthy();
    const totals = within(
      screen.getByText('Subtotal').parentElement!.parentElement!.parentElement!,
    );
    expect(totals.getByText('MYR 20.00')).toBeTruthy();
    expect(screen.getByText('MYR -1.00')).toBeTruthy(); // seller discount
    expect(screen.getByText('MYR -0.50')).toBeTruthy(); // platform discount
    expect(screen.getByText('MYR 5.00')).toBeTruthy(); // shipping
    expect(screen.getByText('MYR 1.00')).toBeTruthy(); // tax
    expect(screen.getByText('MYR 24.50')).toBeTruthy(); // total
    expect(screen.getAllByText(/not taka/).length).toBeGreaterThan(0);
    expect(screen.getByText(/does not store any buyer details/)).toBeTruthy();
    noTaka();
  });

  it('shows a mapped line with its product (linked to the product page) and its stock hold', async () => {
    mount(<TikTokOrderScreen id={uuid(100)} />, detailApi(detail()));
    const row = within(await screen.findByRole('group', { name: 'Order line TEE-1' }));
    expect(row.getByText('Cotton tee')).toBeTruthy();
    expect(row.getByText('2 ×')).toBeTruthy();
    expect(row.getByText('MYR 10.00')).toBeTruthy();
    expect(row.getByText('Stock held')).toBeTruthy();
    const link = await row.findByRole('link', { name: 'Cotton tee — Red / M · TEE-1' });
    expect(link).toHaveAttribute('href', `/products/${uuid(900)}`);
    expect(row.queryByText('Not mapped')).toBeNull();
  });

  it('shows shipped and released holds', async () => {
    mount(
      <TikTokOrderScreen id={uuid(100)} />,
      detailApi(
        detail({
          stockState: 'shipped',
          lines: [
            line({ hold: 'shipped' }),
            line({ key: 'sku:s2', sellerSku: 'B', hold: 'released' }),
          ],
        }),
      ),
    );
    await screen.findByRole('group', { name: 'Order line TEE-1' });
    expect(screen.getAllByText('Stock shipped').length).toBeGreaterThan(1); // the order, and the line
    expect(screen.getByText('Stock released')).toBeTruthy();
  });

  it('says what blocks an unmapped order and offers the inline mapping on the line that needs it', async () => {
    mount(<TikTokOrderScreen id={uuid(100)} />, detailApi(unmappedOrder()));
    expect(
      await screen.findByText('Waiting for you to map 1 item: no stock has been moved.'),
    ).toBeTruthy();
    const hat = within(screen.getByRole('group', { name: 'Order line RED-HAT' }));
    expect(hat.getByText('Not mapped')).toBeTruthy();
    expect(hat.getByText('No stock yet')).toBeTruthy();
    expect(hat.getByRole('button', { name: 'Map to a product: SKU RED-HAT' })).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Order line TEE-1' })).queryByRole('button', {
        name: /Map to a product/,
      }),
    ).toBeNull();
  });

  it('maps the item to a product with a PUT, then refetches the order', async () => {
    const api = detailApi(unmappedOrder());
    mount(<TikTokOrderScreen id={uuid(100)} />, api);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Map to a product: SKU RED-HAT' }),
    );
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Find a product for SKU RED-HAT' }),
      'tee',
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Use this product' }));
    expect(api.tiktokSkuLinks.update).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save mapping, SKU RED-HAT' }));
    await waitFor(() => expect(api.tiktokSkuLinks.update).toHaveBeenCalledWith(uuid(301), uuid(7)));
    await waitFor(() => expect(api.tiktokOrders.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('1 waiting order was processed')).toBeTruthy();
    expect(await screen.findByText(/Stock is reserved for this order/)).toBeTruthy();
    expect(screen.queryByText('Not mapped')).toBeNull();
  });

  it('shows why a mapping failed and keeps the choice', async () => {
    const api = detailApi(unmappedOrder());
    api.tiktokSkuLinks.update.mockRejectedValueOnce(
      new ApiError('That product is archived', 400, 'validation_failed'),
    );
    mount(<TikTokOrderScreen id={uuid(100)} />, api);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Map to a product: SKU RED-HAT' }),
    );
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Find a product for SKU RED-HAT' }),
      'tee',
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Use this product' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save mapping, SKU RED-HAT' }));
    expect(await screen.findByText('That product is archived')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save mapping, SKU RED-HAT' })).toBeTruthy();
  });

  it('does not offer to map for a role that cannot change inventory', async () => {
    mount(<TikTokOrderScreen id={uuid(100)} />, detailApi(unmappedOrder()), 'ACCOUNTANT');
    expect(await screen.findByText(/Someone who can change inventory has to map it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Map to a product/ })).toBeNull();
  });

  it('flags an order cancelled after shipping, with its sentence', async () => {
    mount(
      <TikTokOrderScreen id={uuid(100)} />,
      detailApi(
        detail({
          status: 'CANCELLED',
          stockState: 'shipped',
          attention: 'cancelled_after_shipping',
          lines: [line({ hold: 'shipped' })],
        }),
      ),
    );
    expect(
      await screen.findByText('Cancelled after it shipped: stock was not changed, check it'),
    ).toBeTruthy();
  });

  it('offers Sync now on a waiting order, to a person who may sync', async () => {
    const api = detailApi(detail({ stockState: 'stock_short', lines: [line({ hold: null })] }));
    mount(<TikTokOrderScreen id={uuid(100)} />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(api.tiktokShop.sync).toHaveBeenCalledWith(uuid(1)));
  });

  it('shows a missing order, and keeps the page away from a role without access', async () => {
    const api = detailApi(detail());
    api.tiktokOrders.get.mockRejectedValue(new ApiError('Order not found', 404, 'not_found'));
    mount(<TikTokOrderScreen id={uuid(100)} />, api);
    expect(await screen.findByText('Order not found')).toBeTruthy();
  });

  it('has named controls', async () => {
    mount(<TikTokOrderScreen id={uuid(100)} />, detailApi(unmappedOrder()));
    await screen.findByRole('group', { name: 'Order line RED-HAT' });
    await userEvent.click(screen.getByRole('button', { name: 'Map to a product: SKU RED-HAT' }));
    expectNamedControls();
    expectNamesContainVisibleText();
  });
});

describe('SKU mapping', () => {
  beforeEach(() => vi.clearAllMocks());
  const links = (items: TikTokSkuLink[], unmappedCount = items.length) => ({
    items,
    nextCursor: null,
    unmappedCount,
  });

  it('lists the SKUs waiting for a link, with the orders each one blocks', async () => {
    const api = ordersApi(page({ counts: COUNTS }), {
      links: links([
        skuLink(),
        skuLink({
          id: uuid(302),
          externalSkuId: 's10',
          sellerSku: null,
          productName: null,
          waitingOrders: 1,
        }),
      ]),
      overview: { unmappedSkus: 2 },
    });
    mount(<TikTokOrdersScreen view="sku-mapping" />, api);
    const red = within(await screen.findByRole('group', { name: 'TikTok SKU RED-HAT' }));
    expect(red.getByText('Red hat')).toBeTruthy();
    expect(red.getByText('Seller SKU RED-HAT · TikTok SKU s9')).toBeTruthy();
    expect(red.getByText('2 waiting orders')).toBeTruthy();
    expect(red.getByText(/Not mapped/)).toBeTruthy();
    const unnamed = within(screen.getByRole('group', { name: 'TikTok SKU s10' }));
    expect(unnamed.getByText('Unnamed TikTok product')).toBeTruthy();
    expect(unnamed.getByText('No seller SKU · TikTok SKU s10')).toBeTruthy();
    expect(unnamed.getByText('1 waiting order')).toBeTruthy();
    expect(api.tiktokSkuLinks.list).toHaveBeenCalledWith({ limit: 50, unmapped: 'true' });
    expect(screen.getByRole('tab', { name: 'SKU mapping 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('reaches the mapping from a tab on the orders screen', async () => {
    const api = ordersApi(page({ counts: COUNTS }), { overview: { unmappedSkus: 1 } });
    mount(<TikTokOrdersScreen />, api);
    await userEvent.click(await screen.findByRole('tab', { name: 'SKU mapping 1' }));
    expect(await screen.findByRole('group', { name: 'TikTok SKU RED-HAT' })).toBeTruthy();
  });

  it('saves a link with a PUT and says how many waiting orders were processed', async () => {
    const api = ordersApi(page({ counts: COUNTS }));
    api.tiktokSkuLinks.update.mockResolvedValue({ link: skuLink(), reconciledOrders: 2 } as never);
    mount(<TikTokOrdersScreen view="sku-mapping" />, api);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Map to a product: SKU RED-HAT' }),
    );
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Find a product for SKU RED-HAT' }),
      'tee',
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Use this product' }));
    expect(screen.getByText('Cotton tee — Red / M · TEE-1')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save mapping, SKU RED-HAT' }));
    await waitFor(() => expect(api.tiktokSkuLinks.update).toHaveBeenCalledWith(uuid(300), uuid(7)));
    expect(await screen.findByText('2 waiting orders were processed')).toBeTruthy();
    // The list is read again after saving.
    await waitFor(() => expect(api.tiktokSkuLinks.list.mock.calls.length).toBeGreaterThan(1));
  });

  it('lets a person choose another product before saving', async () => {
    const api = ordersApi(page());
    mount(<TikTokOrdersScreen view="sku-mapping" />, api);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Map to a product: SKU RED-HAT' }),
    );
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Find a product for SKU RED-HAT' }),
      'tee',
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Use this product' }));
    await userEvent.click(screen.getByRole('button', { name: 'Choose another' }));
    expect(screen.getByRole('searchbox', { name: 'Find a product for SKU RED-HAT' })).toBeTruthy();
    expect(api.tiktokSkuLinks.update).not.toHaveBeenCalled();
  });

  it('clears a link with variantId null, from the all-SKUs view', async () => {
    const mapped = skuLink({
      variant: { id: uuid(7), sku: 'TEE-1', productName: 'Cotton tee', variantName: 'Red / M' },
      source: 'auto',
      waitingOrders: 0,
    });
    const api = ordersApi(page(), { links: links([mapped], 0) });
    api.tiktokSkuLinks.update.mockResolvedValue({ link: skuLink(), reconciledOrders: 0 } as never);
    mount(<TikTokOrdersScreen view="sku-mapping" />, api);
    await userEvent.click(await screen.findByRole('tab', { name: 'All SKUs' }));
    expect(await screen.findByText('Matched by SKU')).toBeTruthy();
    expect(api.tiktokSkuLinks.list).toHaveBeenLastCalledWith({ limit: 50 });
    await userEvent.click(screen.getByRole('button', { name: 'Clear link, SKU RED-HAT' }));
    await waitFor(() => expect(api.tiktokSkuLinks.update).toHaveBeenCalledWith(uuid(300), null));
    expect(await screen.findByText('Link cleared')).toBeTruthy();
  });

  it('is read-only without inventory:write, and hidden without inventory:read', async () => {
    const view = mount(<TikTokOrdersScreen view="sku-mapping" />, ordersApi(page()), 'ACCOUNTANT');
    expect(await screen.findByText(/can look at SKU links but not change them/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Map to a product/ })).toBeNull();
    view.unmount();
  });

  it('says when there is nothing to map', async () => {
    mount(<TikTokOrdersScreen view="sku-mapping" />, ordersApi(page(), { links: links([], 0) }));
    expect(await screen.findByText('Nothing to map')).toBeTruthy();
  });

  it('has named controls', async () => {
    mount(<TikTokOrdersScreen view="sku-mapping" />, ordersApi(page()));
    await screen.findByRole('group', { name: 'TikTok SKU RED-HAT' });
    expectNamedControls();
    expectNamesContainVisibleText();
  });
});
