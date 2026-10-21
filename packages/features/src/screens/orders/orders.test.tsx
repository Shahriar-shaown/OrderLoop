import { ApiError } from '@orderloop/api-client';
import type { CustomerDetail, OrderDetail, OrderSummary } from '@orderloop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../../test/mount';
import { expectNamedControls } from '../../../test/a11y';
import { CustomerDetailScreen } from './CustomerDetailScreen';
import { CustomersScreen } from './CustomersScreen';
import { NewOrderScreen } from './NewOrderScreen';
import { OrderDetailScreen } from './OrderDetailScreen';
import { OrdersScreen } from './OrdersScreen';

const summary = (
  n: number,
  status: OrderSummary['status'],
  extra: Partial<OrderSummary> = {},
): OrderSummary => ({
  id: `0197b0a0-0000-7000-8000-00000000000${n}`,
  orderNumber: 1000 + n,
  status,
  source: 'facebook',
  customerId: '0197b0a0-0000-7000-8000-0000000000c1',
  customerName: `Buyer ${n}`,
  phone: '+8801712345678',
  district: 'Dhaka',
  itemCount: n,
  totalMinor: n * 100_000,
  codAmountMinor: n * 100_000,
  createdAt: '2026-10-18T05:00:00.000Z',
  itemsSummary: 'Cotton tee ×1',
  payment: 'cod_pending',
  courier: null,
  ...extra,
});

describe('orders list', () => {
  const list = (items: OrderSummary[], extra: Record<string, unknown> = {}) =>
    vi.fn(async () => ({
      items,
      nextCursor: null,
      total: items.length,
      statusCounts: {},
      ...extra,
    }));

  it('shows real rows from the API, with money formatted in taka and the status in words', async () => {
    const api = {
      orders: {
        list: list([summary(1, 'pending_confirmation'), summary(2, 'delivered')], {
          statusCounts: { pending_confirmation: 1, delivered: 1 },
        }),
      },
    };
    mount(<OrdersScreen />, api);
    const row = await screen.findByRole('row', { name: /#1001/ });
    expect(within(row).getByText('Buyer 1')).toBeTruthy();
    expect(within(row).getByText('Pending confirmation')).toBeTruthy();
    expect(within(row).getByText('COD · Pending')).toBeTruthy();
    expect(within(row).getAllByText('৳1,000.00').length).toBeGreaterThan(0);
    expect(
      within(await screen.findByRole('row', { name: /#1002/ })).getByText('Delivered'),
    ).toBeTruthy();
    expect(screen.getByText('2 orders · 0 selected')).toBeTruthy();
    expect(screen.getByText('Showing 1–2 of 2 orders')).toBeTruthy();
  });

  it('shows a chip for every status with the counts the API gives', async () => {
    const api = {
      orders: {
        list: list([summary(1, 'confirmed')], {
          total: 12,
          statusCounts: { pending_confirmation: 3, confirmed: 9 },
        }),
      },
    };
    mount(<OrdersScreen />, api);
    expect(await screen.findByRole('tab', { name: 'All 12' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Pending confirmation 3' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Confirmed 9' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Return requested 0' })).toBeTruthy();
  });

  it('sends filters, sort and search to the server as the API expects them', async () => {
    const orders = list([summary(1, 'confirmed')]);
    mount(<OrdersScreen />, { orders: { list: orders } });
    await screen.findByRole('row', { name: /#1001/ });
    await userEvent.click(screen.getByRole('tab', { name: /^Confirmed/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Sort: Newest first' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Highest total' }));
    await userEvent.click(screen.getByRole('button', { name: 'Source: All' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Facebook' }));
    await userEvent.type(screen.getByLabelText('Search'), 'rina');
    await waitFor(() =>
      expect(orders).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'confirmed',
          source: 'facebook',
          sort: 'totalMinor',
          dir: 'desc',
          q: 'rina',
          limit: 25,
        }),
      ),
    );
  });

  it('filters by a range of days from the date chip', async () => {
    const orders = list([summary(1, 'confirmed')]);
    mount(<OrdersScreen />, { orders: { list: orders } });
    await userEvent.click(await screen.findByRole('button', { name: 'Date: Any' }));
    await userEvent.type(await screen.findByLabelText('From date'), '2026-10-01');
    await userEvent.type(screen.getByLabelText('To date'), '2026-10-17');
    await waitFor(() =>
      expect(orders).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: '2026-10-01', to: '2026-10-17' }),
      ),
    );
  });

  it('starts from the status and days it is given (the dashboard links here)', async () => {
    const orders = list([summary(1, 'delivered')]);
    mount(
      <OrdersScreen initialStatus="delivered" initialFrom="2026-10-01" initialTo="2026-10-07" />,
      { orders: { list: orders } },
    );
    await screen.findByRole('row', { name: /#1001/ });
    expect(orders).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'delivered', from: '2026-10-01', to: '2026-10-07' }),
    );
  });

  it('reads the list by cursor: Next asks for the next page, Previous goes back to the one before', async () => {
    const orders = vi.fn(async (query: { cursor?: string }) =>
      query.cursor === 'c2'
        ? { items: [summary(2, 'confirmed')], nextCursor: null, total: 2, statusCounts: {} }
        : { items: [summary(1, 'confirmed')], nextCursor: 'c2', total: 2, statusCounts: {} },
    );
    mount(<OrdersScreen />, { orders: { list: orders } });
    await screen.findByRole('row', { name: /#1001/ });
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('row', { name: /#1002/ });
    expect(orders).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c2' }));
    expect(screen.getByText('Showing 26–26 of 2 orders')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('row', { name: /#1001/ })).toBeTruthy();
  });

  it('never sends the cursor of an earlier page together with new filters', async () => {
    const orders = vi.fn(async (query: { cursor?: string }) => ({
      items: [summary(query.cursor ? 2 : 1, 'confirmed')],
      nextCursor: query.cursor ? null : 'c2',
      total: 2,
      statusCounts: {},
    }));
    mount(<OrdersScreen />, { orders: { list: orders } });
    await screen.findByRole('row', { name: /#1001/ });
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('row', { name: /#1002/ });
    await userEvent.type(screen.getByLabelText('Search'), 'rina');
    await waitFor(() =>
      expect(orders).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'rina' })),
    );
    for (const [query] of orders.mock.calls as unknown as [Record<string, unknown>][])
      if (query.q) expect(query).not.toHaveProperty('cursor');
  });

  it('keeps the reason dialog open, with the reason typed and the error shown, when a bulk cancel fails', async () => {
    const bulk = vi.fn(async () => {
      throw new ApiError(
        'You are offline. Nothing was sent. Connect and try again.',
        undefined,
        'offline',
      );
    });
    mount(<OrdersScreen />, {
      orders: { list: list([summary(1, 'confirmed')]), bulkChangeStatus: bulk },
    });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select order 1001' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel…' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Courier strike');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel orders' }));
    expect(await within(dialog).findByText(/You are offline/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((within(dialog).getByLabelText(/Reason/) as HTMLInputElement).value).toBe(
      'Courier strike',
    );
  });

  it('applies a bulk action to exactly the selected orders and reports the ones that could not move', async () => {
    const bulk = vi.fn(async (body: { orderIds: string[] }) => ({
      results: body.orderIds.map((orderId, i) => ({
        orderId,
        orderNumber: 1001 + i,
        ok: i === 0,
        status: i === 0 ? 'confirmed' : 'pending_confirmation',
        error:
          i === 0
            ? null
            : {
                code: 'insufficient_stock',
                message: 'Not enough stock for one item: SKU-9: only 1 available, 4 needed',
              },
      })),
      succeeded: 1,
      failed: body.orderIds.length - 1,
    }));
    const api = {
      orders: {
        list: list([
          summary(1, 'pending_confirmation'),
          summary(2, 'pending_confirmation'),
          summary(3, 'pending_confirmation'),
        ]),
        bulkChangeStatus: bulk,
      },
    };
    mount(<OrdersScreen />, api);
    await screen.findByRole('row', { name: /#1001/ });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select order 1001' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select order 1003' }));
    expect(await screen.findByText('2 orders selected')).toBeTruthy();
    expect(screen.getByText('3 orders · 2 selected')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
    expect(bulk).toHaveBeenCalledWith({
      orderIds: ['0197b0a0-0000-7000-8000-000000000001', '0197b0a0-0000-7000-8000-000000000003'],
      status: 'confirmed',
    });
    expect(await screen.findByText(/only 1 available, 4 needed/)).toBeTruthy();
    expect(screen.getByText('1 order selected')).toBeTruthy(); // only the failed one stays selected
  });

  it('says plainly when a bulk change is refused for a row the role may not touch', async () => {
    const bulk = vi.fn(async (body: { orderIds: string[] }) => ({
      results: body.orderIds.map((orderId) => ({
        orderId,
        orderNumber: 1001,
        ok: false,
        status: null,
        error: { code: 'forbidden', message: 'Forbidden' },
      })),
      succeeded: 0,
      failed: body.orderIds.length,
    }));
    mount(<OrdersScreen />, {
      orders: { list: list([summary(1, 'confirmed')]), bulkChangeStatus: bulk },
    });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select order 1001' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('#1001: Your role is not allowed to do that to this order.'),
    ).toBeTruthy();
  });

  it('offers no bulk Delivered or Returned (those need orders:close)', async () => {
    mount(<OrdersScreen />, { orders: { list: list([summary(1, 'in_transit')]) } }, 'STAFF');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select order 1001' }));
    expect(screen.queryByRole('button', { name: /delivered|returned/i })).toBeNull();
  });

  it('the selection bar clears the selection', async () => {
    mount(<OrdersScreen />, { orders: { list: list([summary(1, 'confirmed')]) } });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select order 1001' }));
    expect(await screen.findByText('1 order selected')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.queryByText('1 order selected')).toBeNull());
  });

  it('cancelling in bulk asks for a reason first', async () => {
    const bulk = vi.fn(async () => ({ results: [], succeeded: 0, failed: 0 }));
    mount(<OrdersScreen />, {
      orders: { list: list([summary(1, 'confirmed')]), bulkChangeStatus: bulk },
    });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select order 1001' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel…' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel orders' }));
    expect(await within(dialog).findByText('Say why (at least 3 characters)')).toBeTruthy();
    expect(bulk).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Courier strike');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel orders' }));
    await waitFor(() =>
      expect(bulk).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'cancelled', reason: 'Courier strike' }),
      ),
    );
  });

  it('a row menu offers view, edit and cancel, and cancelling one order asks for a reason', async () => {
    const changeStatus = vi.fn(async () => ({}));
    mount(<OrdersScreen />, {
      orders: { list: list([summary(1, 'confirmed')]), changeStatus },
    });
    const row = await screen.findByRole('row', { name: /#1001/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Actions for order 1001' }));
    expect(await screen.findByRole('menuitem', { name: 'View details' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel…' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Duplicate order');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() =>
      expect(changeStatus).toHaveBeenCalledWith('0197b0a0-0000-7000-8000-000000000001', {
        status: 'cancelled',
        reason: 'Duplicate order',
      }),
    );
  });

  it('opens an order when its row is pressed', async () => {
    const { navigation } = mount(<OrdersScreen />, {
      orders: { list: list([summary(1, 'confirmed')]) },
    });
    const row = await screen.findByRole('row', { name: /#1001/ });
    await userEvent.click(within(row).getByText('Buyer 1'));
    expect(navigation.push).toHaveBeenCalledWith('/orders/0197b0a0-0000-7000-8000-000000000001');
  });

  it('a role that cannot write sees no selection boxes and no way to create', async () => {
    mount(<OrdersScreen />, { orders: { list: list([summary(1, 'confirmed')]) } }, 'ACCOUNTANT');
    await screen.findByRole('row', { name: /#1001/ });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('Create order')).toBeNull();
    expect(screen.queryByText('Import')).toBeNull();
  });

  it('shows an honest empty state, and one for a search with no results that can clear the filters', async () => {
    mount(<OrdersScreen />, { orders: { list: list([]) } });
    expect(await screen.findByText('No orders yet')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Search'), 'nobody');
    expect(await screen.findByText('No orders match')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('No orders yet')).toBeTruthy();
  });

  it('says what went wrong and offers to try again', async () => {
    const orders = vi.fn().mockRejectedValue(new Error('network down'));
    mount(<OrdersScreen />, { orders: { list: orders } });
    const retry = await screen.findByRole('button', { name: 'Try again' }, { timeout: 10_000 });
    orders.mockResolvedValue({
      items: [summary(1, 'confirmed')],
      nextCursor: null,
      total: 1,
      statusCounts: {},
    });
    await userEvent.click(retry);
    expect(await screen.findByRole('row', { name: /#1001/ })).toBeTruthy();
  }, 20_000);
});

const detail = (
  status: OrderDetail['status'],
  allowed: OrderDetail['allowedStatuses'],
): OrderDetail => ({
  id: '0197b0a0-0000-7000-8000-000000000001',
  orderNumber: 1001,
  status,
  source: 'whatsapp',
  sourceReference: null,
  notes: null,
  customer: {
    id: '0197b0a0-0000-7000-8000-0000000000c1',
    name: 'Rina Akter',
    phone: '+8801712345678',
  },
  shipping: {
    recipientName: 'Rina Akter',
    phone: '+8801712345678',
    line1: 'House 5',
    area: 'Dhanmondi',
    district: 'Dhaka',
    division: 'Dhaka',
    postalCode: null,
  },
  items: [
    {
      id: '0197b0a0-0000-7000-8000-0000000000a1',
      variantId: '0197b0a0-0000-7000-8000-0000000000b1',
      sku: 'TEE-1',
      productName: 'Cotton tee',
      variantName: 'Red / M',
      quantity: 2,
      unitPriceMinor: 85_050,
      discountMinor: 0,
      lineTotalMinor: 170_100,
    },
  ],
  subtotalMinor: 170_100,
  discountMinor: 10_000,
  deliveryChargeMinor: 6_000,
  totalMinor: 166_100,
  advancePaidMinor: 20_000,
  codAmountMinor: 146_100,
  stockHeld: status === 'confirmed',
  version: 3,
  createdAt: '2026-10-18T05:00:00.000Z',
  updatedAt: '2026-10-18T05:00:00.000Z',
  history: [
    {
      id: '0197b0a0-0000-7000-8000-0000000000d1',
      fromStatus: null,
      toStatus: 'pending_confirmation',
      reason: 'Order created',
      actorUserId: 'u',
      actorName: 'Anwar',
      createdAt: '2026-10-18T05:00:00.000Z',
    },
    {
      id: '0197b0a0-0000-7000-8000-0000000000d2',
      fromStatus: 'pending_confirmation',
      toStatus: 'confirmed',
      reason: null,
      actorUserId: 'u',
      actorName: 'Anwar',
      createdAt: '2026-10-18T05:05:00.000Z',
    },
  ],
  allowedStatuses: allowed,
});

const cash = (extra: Record<string, unknown> = {}) => ({
  state: 'awaiting_delivery',
  expectedMinor: 146_100,
  collectedMinor: 0,
  chargesMinor: 0,
  netMinor: 0,
  outstandingMinor: 146_100,
  hasCourierShipment: false,
  lines: 0,
  ...extra,
});

describe('order page', () => {
  const api = (
    order: OrderDetail,
    extra: Record<string, unknown> = {},
    options: { payment?: OrderSummary['payment']; cash?: ReturnType<typeof cash> } = {},
  ) => ({
    orders: {
      get: async () => order,
      duplicates: async () => [],
      changeStatus: vi.fn(async () => order),
      list: async () => ({
        items: [
          summary(1, order.status, { id: order.id, payment: options.payment ?? 'cod_pending' }),
        ],
        nextCursor: null,
        total: 1,
        statusCounts: {},
      }),
      ...extra,
    },
    finance: { orderCash: async () => options.cash ?? cash() },
    shipments: { forOrder: async () => [], get: async () => null },
    couriers: { list: async () => [] },
  });

  it('shows the server’s totals, the cash-on-delivery amount and the status history', async () => {
    mount(
      <OrderDetailScreen id={detail('confirmed', []).id} />,
      api(detail('confirmed', ['ready_to_ship', 'cancelled'])),
    );
    expect(await screen.findByRole('heading', { name: '#1001' })).toBeTruthy();
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0);
    expect((await screen.findAllByText('COD · Pending')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/WhatsApp/).length).toBeGreaterThan(0); // created … · source
    expect(screen.getAllByText('৳1,661.00').length).toBeGreaterThan(0); // order total
    expect(screen.getAllByText('৳1,461.00').length).toBeGreaterThan(0); // cash on delivery
    expect(screen.getAllByText('−৳100.00').length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        'Stock is reserved for this order. Cancelling it puts the stock back on sale.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Order created')).toBeTruthy();
    expect(screen.getAllByText('Anwar', { exact: false }).length).toBeGreaterThan(1);
  });

  it('shows Expected, Collected and Settled as three different figures, each saying where it stands', async () => {
    mount(<OrderDetailScreen id="x" />, api(detail('shipped', ['in_transit', 'delivered'])));
    await screen.findByRole('heading', { name: '#1001' });
    expect(await screen.findByRole('group', { name: 'Expected: ৳1,461.00' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Collected: ৳0.00' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Settled to you: ৳0.00' })).toBeTruthy();
    expect(screen.getAllByText('Not yet reported').length).toBe(2);
    // Dates are only the ones that happened: the steps still to come carry none.
    expect(screen.getByText('Cash settled')).toBeTruthy();
    expect(
      screen.getByText('Appears when a courier statement reports the cash. No date is promised.'),
    ).toBeTruthy();
  });

  it('shows what a courier statement reported, with its charges', async () => {
    mount(
      <OrderDetailScreen id="x" />,
      api(
        detail('delivered', ['return_requested']),
        {},
        {
          payment: 'cod_collected',
          cash: cash({
            collectedMinor: 146_100,
            chargesMinor: 11_000,
            netMinor: 135_100,
            hasCourierShipment: true,
            lines: 1,
            state: 'paid',
          }),
        },
      ),
    );
    expect(await screen.findByRole('group', { name: 'Collected: ৳1,461.00' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Settled to you: ৳1,351.00' })).toBeTruthy();
    expect(screen.getByText('After ৳110.00 courier charges')).toBeTruthy();
    expect((await screen.findAllByText('COD · Collected')).length).toBeGreaterThan(0);
  });

  it('leaves out the Collected and Settled figures for a role that cannot read finance', async () => {
    mount(<OrderDetailScreen id="x" />, api(detail('confirmed', [])), 'STAFF');
    await screen.findByRole('heading', { name: '#1001' });
    expect(screen.getByRole('group', { name: 'Expected: ৳1,461.00' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: /^Collected/ })).toBeNull();
    expect(screen.queryByRole('group', { name: /^Settled/ })).toBeNull();
  });

  it('offers only the moves the state machine allows', async () => {
    mount(
      <OrderDetailScreen id="x" />,
      api(detail('shipped', ['in_transit', 'delivered', 'delivery_failed'])),
    );
    await screen.findByRole('heading', { name: '#1001' });
    expect(screen.getByRole('button', { name: 'Mark in transit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark delivered' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm order' })).toBeNull();
    // The goods have left: cancelling is off, and the card says why.
    const cancel = screen.getByRole('button', { name: 'Cancel order' });
    expect(cancel.hasAttribute('disabled') || cancel.getAttribute('aria-disabled') === 'true').toBe(
      true,
    );
    expect(screen.getByText(/Parcels already with a courier can’t be cancelled/)).toBeTruthy();
  });

  it('confirms with one press, sending the version it saw', async () => {
    const order = detail('pending_confirmation', ['confirmed', 'cancelled']);
    const o = api(order);
    mount(<OrderDetailScreen id={order.id} />, o);
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm order' }));
    await waitFor(() =>
      expect(o.orders.changeStatus).toHaveBeenCalledWith(order.id, {
        status: 'confirmed',
        ifVersion: 3,
      }),
    );
  });

  it('cancelling needs a reason, and sends it', async () => {
    const order = detail('confirmed', ['ready_to_ship', 'cancelled']);
    const o = api(order);
    mount(<OrderDetailScreen id={order.id} />, o);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(await within(dialog).findByText('Say why (at least 3 characters)')).toBeTruthy();
    expect(o.orders.changeStatus).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Customer changed their mind');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() =>
      expect(o.orders.changeStatus).toHaveBeenCalledWith(order.id, {
        status: 'cancelled',
        reason: 'Customer changed their mind',
        ifVersion: 3,
      }),
    );
  });

  /** A returned order with two lines: 2 × Red / M and 1 × Blue / L. */
  const twoLines = () => {
    const base = detail('return_requested', ['returned', 'delivered']);
    const blue = {
      ...base.items[0]!,
      id: '0197b0a0-0000-7000-8000-0000000000a2',
      variantId: '0197b0a0-0000-7000-8000-0000000000b2',
      sku: 'TEE-2',
      variantName: 'Blue / L',
      quantity: 1,
    };
    return { ...base, items: [base.items[0]!, blue] };
  };
  const confirmReturn = async (dialog: HTMLElement) => {
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Arrived torn');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as returned' }));
  };

  it('a return starts with every line fully back and resaleable, and sends no list for that', async () => {
    const order = twoLines();
    const o = api(order);
    mount(<OrderDetailScreen id={order.id} />, o);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as returned' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Returned: TEE-1')).toHaveValue('2');
    expect(within(dialog).getByLabelText('Returned: TEE-2')).toHaveValue('1');
    expect(within(dialog).getByText('Returning 2 of 2 Red / M; 1 of 1 Blue / L')).toBeTruthy();
    expectNamedControls();
    await confirmReturn(dialog);
    await waitFor(() =>
      expect(o.orders.changeStatus).toHaveBeenCalledWith(order.id, {
        status: 'returned',
        reason: 'Arrived torn',
        ifVersion: 3,
      }),
    );
  });

  it('a partial return lists each returned line, with a quantity only where it is partial', async () => {
    const order = twoLines();
    const o = api(order);
    mount(<OrderDetailScreen id={order.id} />, o);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as returned' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Decrease Returned: TEE-1'));
    await userEvent.click(within(dialog).getByLabelText('Decrease Returned: TEE-2'));
    expect(within(dialog).getByText('Returning 1 of 2 Red / M; 0 of 1 Blue / L')).toBeTruthy();
    await userEvent.selectOptions(within(dialog).getByLabelText('Condition: TEE-1'), 'DAMAGED');
    expect(within(dialog).queryByLabelText('Condition: TEE-2')).toBeNull();
    await confirmReturn(dialog);
    await waitFor(() =>
      expect(o.orders.changeStatus).toHaveBeenCalledWith(
        order.id,
        expect.objectContaining({
          status: 'returned',
          returnedItems: [{ itemId: order.items[0]!.id, condition: 'DAMAGED', quantity: 1 }],
        }),
      ),
    );
  });

  it('a full return with one damaged line lists every line, because an omitted line would add nothing', async () => {
    const order = twoLines();
    const o = api(order);
    mount(<OrderDetailScreen id={order.id} />, o);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as returned' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Condition: TEE-2'), 'DAMAGED');
    await confirmReturn(dialog);
    await waitFor(() =>
      expect(o.orders.changeStatus).toHaveBeenCalledWith(
        order.id,
        expect.objectContaining({
          returnedItems: [
            { itemId: order.items[0]!.id, condition: 'RESALEABLE' },
            { itemId: order.items[1]!.id, condition: 'DAMAGED' },
          ],
        }),
      ),
    );
  });

  it('will not mark a return with nothing back', async () => {
    const order = twoLines();
    const o = api(order);
    mount(<OrderDetailScreen id={order.id} />, o);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as returned' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Decrease Returned: TEE-1'));
    await userEvent.click(within(dialog).getByLabelText('Decrease Returned: TEE-1'));
    await userEvent.click(within(dialog).getByLabelText('Decrease Returned: TEE-2'));
    await confirmReturn(dialog);
    expect(await within(dialog).findByText(/at least one item came back/)).toBeTruthy();
    expect(o.orders.changeStatus).not.toHaveBeenCalled();
  });

  it('shows a server error on a returned entry beside the line it belongs to', async () => {
    const order = twoLines();
    const o = api(order);
    // Only TEE-2 is listed, so entry 0 of the list is TEE-2, not the first line of the order.
    o.orders.changeStatus.mockRejectedValueOnce(
      new ApiError('bad', 400, 'validation_failed', [
        { path: 'body.returnedItems.0.quantity', message: 'More than was sent' },
      ]),
    );
    mount(<OrderDetailScreen id={order.id} />, o);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as returned' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Decrease Returned: TEE-1'));
    await userEvent.click(within(dialog).getByLabelText('Decrease Returned: TEE-1'));
    await confirmReturn(dialog);
    const message = await within(dialog).findByText('More than was sent');
    expect(message.closest('[role="alert"]')).toBeTruthy();
    const line = message.parentElement!;
    expect(within(line).getByLabelText('Returned: TEE-2')).toBeTruthy();
  });

  it('tells a person what to do when the courier says only part was delivered', async () => {
    const order = detail('in_transit', ['delivered', 'delivery_failed']);
    const o = api(order);
    (o as Record<string, unknown>).shipments = {
      forOrder: async () => [
        {
          id: 's1',
          status: 'partial_delivered',
          provider: 'steadfast',
          createdAt: '2026-10-18T06:00:00.000Z',
        },
      ],
      get: async () => null,
    };
    mount(<OrderDetailScreen id={order.id} />, o);
    expect(await screen.findByText('The courier delivered only part of the parcel')).toBeTruthy();
    expect(screen.getByText(/enter only the units that came back/)).toBeTruthy();
  });

  describe('closing an order by hand needs orders:close', () => {
    const closable = () => detail('shipped', ['in_transit', 'delivered', 'return_requested']);
    it('hides Mark delivered from staff and says why', async () => {
      const order = closable();
      mount(<OrderDetailScreen id={order.id} />, api(order), 'STAFF');
      await screen.findByRole('heading', { name: '#1001' });
      expect(screen.queryByRole('button', { name: 'Mark delivered' })).toBeNull();
      expect(
        screen.getByText(
          'Only an owner, admin or manager can mark an order delivered or returned by hand.',
        ),
      ).toBeTruthy();
    });

    it('hides Mark as returned from staff', async () => {
      const order = detail('return_requested', ['returned', 'delivered']);
      mount(<OrderDetailScreen id={order.id} />, api(order), 'STAFF');
      await screen.findByRole('heading', { name: '#1001' });
      expect(screen.queryByRole('button', { name: 'Mark as returned' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Mark delivered' })).toBeNull();
      expect(screen.getByText(/Only an owner, admin or manager can mark/)).toBeTruthy();
    });

    it('offers both to a manager, and gives no hint', async () => {
      const order = detail('return_requested', ['returned', 'delivered']);
      mount(<OrderDetailScreen id={order.id} />, api(order), 'MANAGER');
      expect(await screen.findByRole('button', { name: 'Mark as returned' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Mark delivered' })).toBeTruthy();
      expect(screen.queryByText(/Only an owner, admin or manager can mark/)).toBeNull();
    });

    it('still lets staff do the moves that are theirs', async () => {
      const order = closable();
      mount(<OrderDetailScreen id={order.id} />, api(order), 'STAFF');
      expect(await screen.findByRole('button', { name: 'Mark in transit' })).toBeTruthy();
    });
  });

  it('warns that a cash amount with paisa cannot be booked, and disables Book', async () => {
    const order = { ...detail('ready_to_ship', ['shipped', 'cancelled']), codHasPaisa: true };
    const o = api(order);
    (o as Record<string, unknown>).couriers = {
      list: async () => [
        {
          provider: 'mock',
          name: 'Simulated courier',
          simulated: true,
          available: true,
          capabilities: { locations: false, quote: false },
          connection: { enabled: true, hasCredentials: false },
        },
      ],
    };
    mount(<OrderDetailScreen id={order.id} />, o);
    expect(await screen.findByText('This order cannot be booked with a courier')).toBeTruthy();
    expect(screen.getByText(/Cancel the order and enter it again/)).toBeTruthy();
    const book = screen.getByRole('button', { name: 'Book simulated parcel' });
    expect(book.hasAttribute('disabled') || book.getAttribute('aria-disabled') === 'true').toBe(
      true,
    );
  });

  it('gives a soft heads-up before confirming when a courier is on and the cash has paisa', async () => {
    const order = { ...detail('pending_confirmation', ['confirmed']), codHasPaisa: true };
    const o = api(order);
    (o as Record<string, unknown>).couriers = {
      list: async () => [
        {
          provider: 'mock',
          name: 'Simulated courier',
          simulated: true,
          available: true,
          capabilities: { locations: false, quote: false },
          connection: { enabled: true, hasCredentials: false },
        },
      ],
    };
    mount(<OrderDetailScreen id={order.id} />, o);
    expect(await screen.findByText('Cash to collect has paisa')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm order' })).toBeTruthy();
  });

  it('says to book a courier when the order is ready to ship, and shows the booking form', async () => {
    const order = detail('ready_to_ship', ['shipped', 'cancelled']);
    const o = api(order);
    (o as Record<string, unknown>).couriers = {
      list: async () => [
        {
          provider: 'mock',
          name: 'Simulated courier',
          simulated: true,
          available: true,
          capabilities: { locations: false, quote: false },
          connection: { enabled: true, hasCredentials: false },
        },
      ],
    };
    mount(<OrderDetailScreen id={order.id} />, o);
    expect(await screen.findByText('Next: book a courier')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Courier & tracking' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Book simulated parcel' })).toBeTruthy();
  });

  it('lets an owner cancel only while no courier shipment is live', async () => {
    const order = detail('ready_to_ship', ['shipped', 'cancelled']);
    const o = api(order);
    (o as Record<string, unknown>).shipments = {
      forOrder: async () => [
        { id: 's1', status: 'booked', provider: 'mock', createdAt: '2026-10-18T06:00:00.000Z' },
      ],
      get: async () => null,
    };
    mount(<OrderDetailScreen id={order.id} />, o);
    expect(await screen.findByText(/Cancel the shipment first/)).toBeTruthy();
    const cancel = screen.getByRole('button', { name: 'Cancel order' });
    expect(cancel.hasAttribute('disabled') || cancel.getAttribute('aria-disabled') === 'true').toBe(
      true,
    );
  });

  it('warns about possible repeats without judging the customer, and shows no actions to a read-only role', async () => {
    const order = detail('pending_confirmation', ['confirmed']);
    mount(
      <OrderDetailScreen id={order.id} />,
      api(order, {
        duplicates: async () => [
          {
            orderId: 'o2',
            orderNumber: 1000,
            status: 'confirmed',
            createdAt: '2026-10-18T04:59:00.000Z',
            totalMinor: 1,
            reasons: ['Placed 2 minutes ago for the same phone number'],
          },
        ],
      }),
      'ACCOUNTANT',
    );
    expect(await screen.findByText('Possible repeat of another recent order')).toBeTruthy();
    expect(screen.getByText('A hint only. It says nothing about the customer.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm order' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
    expect(screen.queryByText(/fraud|risk|blacklist/i)).toBeNull();
  });

  it('says what went wrong when the order cannot be loaded', async () => {
    const order = detail('confirmed', []);
    mount(<OrderDetailScreen id={order.id} />, {
      ...api(order),
      orders: { ...api(order).orders, get: async () => Promise.reject(new Error('nope')) },
    });
    expect(
      await screen.findByRole('button', { name: 'Try again' }, { timeout: 5000 }),
    ).toBeTruthy();
  });
});

describe('new order form', () => {
  const variantWith = (extra: Record<string, unknown> = {}) => ({
    id: '0197b0a0-0000-7000-8000-0000000000b1',
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
    ...extra,
  });
  const variant = variantWith();
  const customerDetail: CustomerDetail = {
    id: '0197b0a0-0000-7000-8000-0000000000c1',
    name: 'Sadia Islam',
    phone: '+8801611908712',
    email: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    stats: {
      ordersCount: 2,
      deliveredCount: 2,
      cancelledCount: 0,
      returnedCount: 0,
      deliveredValueMinor: 328_000,
      lastOrderAt: '2026-10-01T00:00:00.000Z',
    },
    addresses: [
      {
        id: '0197b0a0-0000-7000-8000-0000000000e1',
        label: 'Home',
        recipientName: 'Sadia Islam',
        phone: '+8801611908712',
        line1: 'House 24, Road 3',
        area: 'Agrabad',
        district: 'Chattogram',
        division: 'Chattogram',
        postalCode: null,
        isDefault: true,
      },
    ],
  };
  const orderApi = (
    create = vi.fn(async () => ({ ...detail('pending_confirmation', ['confirmed']), id: 'new1' })),
    v: ReturnType<typeof variantWith> = variant,
  ) => ({
    customers: {
      list: async (q: { q?: string }) => ({
        items: q.q === 'sadia' ? [customerDetail] : [],
        nextCursor: null,
      }),
      get: async () => customerDetail,
    },
    products: {
      list: async () => ({
        items: [{ id: 'p', name: 'Cotton tee', variants: [v] }],
        nextCursor: null,
      }),
    },
    orders: { create, checkDuplicates: vi.fn(async () => []) },
  });

  async function addItem() {
    await userEvent.type(screen.getByLabelText('Add an item'), 'tee');
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
  }
  async function fill() {
    await userEvent.click(await screen.findByRole('button', { name: 'New customer' }));
    await userEvent.type(await screen.findByLabelText(/^Phone/), '01712-345678');
    await userEvent.type(screen.getByLabelText('Customer name', { exact: false }), 'Rina Akter');
    await userEvent.type(screen.getByLabelText('Recipient name', { exact: false }), 'Rina Akter');
    await userEvent.type(screen.getByLabelText(/^Address/), 'House 5, Road 3');
    await userEvent.type(screen.getByLabelText('Thana / upazila', { exact: false }), 'Dhanmondi');
    await userEvent.type(screen.getByLabelText('District', { exact: false }), 'Dhaka');
    await addItem();
  }

  it('is laid out as four numbered steps with a summary and no payment-method or courier choice', async () => {
    mount(<NewOrderScreen />, orderApi());
    expect(await screen.findByRole('heading', { name: 'Create order' })).toBeTruthy();
    for (const title of [
      '1 · Customer',
      '2 · Delivery address',
      '3 · Products',
      '4 · Payment & source',
    ])
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Order summary' })).toBeTruthy();
    expect(screen.getByText('Add a product to see the total.')).toBeTruthy();
    expect(screen.queryByText(/bKash|Nagad/)).toBeNull();
    expect(screen.queryByLabelText('Courier')).toBeNull();
  });

  it('estimates the total as the person types, labelled as an estimate', async () => {
    mount(<NewOrderScreen />, orderApi());
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Increase Quantity (TEE-1)' }));
    await userEvent.type(screen.getByLabelText('Discount (৳)'), '100');
    await userEvent.type(screen.getByLabelText('Delivery charge (৳)'), '60');
    await userEvent.type(screen.getByLabelText('Advance paid (৳)'), '200');
    expect((await screen.findAllByText('৳1,661.00')).length).toBeGreaterThan(0); // order total
    expect(screen.getAllByText('৳1,461.00').length).toBeGreaterThan(0); // COD to collect
    expect(screen.getByText('Total · COD to collect')).toBeTruthy();
    expect(
      screen.getByText('An estimate. The final figures are worked out when you save.'),
    ).toBeTruthy();
  });

  it('shows a margin estimate, labelled as one, only when every product has a cost', async () => {
    mount(<NewOrderScreen />, orderApi(undefined, variantWith({ costMinor: 50_000 })));
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Increase Quantity (TEE-1)' }));
    expect(await screen.findByText('Your estimate · not profit yet')).toBeTruthy();
    expect(screen.getByText('−৳1,000.00')).toBeTruthy(); // product cost
    expect(screen.getByText('৳701.00')).toBeTruthy(); // 2 × 850.50 − 1,000.00
    expect(
      screen.getByText(/Cash counts as profit only after the courier settles it/),
    ).toBeTruthy();
  });

  it('leaves the margin out when a product has no cost', async () => {
    mount(<NewOrderScreen />, orderApi());
    await fill();
    expect(screen.queryByText('Your estimate · not profit yet')).toBeNull();
  });

  it('warns when a line would leave stock below the reorder point, and when it asks for more than is available', async () => {
    mount(<NewOrderScreen />, orderApi(undefined, variantWith({ reorderPoint: 9 })));
    await fill();
    expect(
      await screen.findByText(
        'Cotton tee — Red / M: only 9 left. After this order 8 remain, below the reorder point of 9.',
      ),
    ).toBeTruthy();
    const qty = screen.getByLabelText('Quantity (TEE-1)');
    await userEvent.clear(qty);
    await userEvent.type(qty, '12');
    expect(await screen.findByText(/only 9 available, 12 on this order/)).toBeTruthy();
    expect(screen.getByText('1 product short of stock — to do')).toBeTruthy();
  });

  it('never sends a total: only quantities, prices and the three adjustments, with one idempotency key', async () => {
    const create = vi.fn(async () => ({
      ...detail('pending_confirmation', ['confirmed']),
      id: 'new1',
    }));
    const { navigation } = mount(<NewOrderScreen />, orderApi(create));
    await fill();
    await userEvent.type(screen.getByLabelText('Delivery charge (৳)'), '60');
    await userEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const sent = (create.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
    expect(sent).toMatchObject({
      customer: { name: 'Rina Akter', phone: '+8801712345678' },
      items: [{ variantId: variant.id, quantity: 1 }],
      deliveryChargeMinor: 6000,
      confirm: false,
      idempotencyKey: expect.stringMatching(/^app-/),
    });
    for (const forbidden of ['totalMinor', 'subtotalMinor', 'codAmountMinor', 'lineTotalMinor'])
      expect(JSON.stringify(sent)).not.toContain(forbidden);
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/orders/new1'));
  });

  it('“Confirm order” asks the server to reserve stock in the same step', async () => {
    const create = vi.fn(async () => ({ ...detail('confirmed', ['ready_to_ship']), id: 'new2' }));
    mount(<NewOrderScreen />, orderApi(create));
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ confirm: true })),
    );
  });

  it('reuses the same idempotency key when the request is retried after a failure', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ...detail('pending_confirmation', ['confirmed']), id: 'new3' });
    mount(<NewOrderScreen />, orderApi(create));
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const calls = create.mock.calls as unknown as [{ idempotencyKey: string }][];
    expect((calls[1]![0] as { idempotencyKey: string }).idempotencyKey).toBe(
      (calls[0]![0] as { idempotencyKey: string }).idempotencyKey,
    );
  });

  it('starts from an existing customer: their details and default address are filled in, and only their id is sent', async () => {
    const create = vi.fn(async () => ({ ...detail('confirmed', ['ready_to_ship']), id: 'new4' }));
    mount(<NewOrderScreen />, orderApi(create));
    await userEvent.type(await screen.findByLabelText('Find a customer'), 'sadia');
    await userEvent.click(await screen.findByRole('button', { name: 'Use customer Sadia Islam' }));
    expect(await screen.findByText('Repeat customer')).toBeTruthy();
    expect(screen.getByText(/2 previous orders · ৳3,280.00 delivered/)).toBeTruthy();
    expect(await screen.findByDisplayValue('House 24, Road 3')).toBeTruthy();
    await addItem();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const sent = (create.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
    expect(sent).toMatchObject({
      customerId: customerDetail.id,
      address: { line1: 'House 24, Road 3', area: 'Agrabad', district: 'Chattogram' },
    });
    expect(sent).not.toHaveProperty('customer');
    // Change brings the search back.
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(await screen.findByLabelText('Find a customer')).toBeTruthy();
  });

  it('says what is missing before sending anything', async () => {
    const create = vi.fn();
    mount(<NewOrderScreen />, orderApi(create));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as draft' }));
    expect(await screen.findByText('Choose a customer or enter their details')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the primary action in view on a phone and tracks the checklist', async () => {
    mount(<NewOrderScreen />, orderApi());
    expect(await screen.findByText('Customer selected — to do')).toBeTruthy();
    expect(screen.getByText('Address complete — to do')).toBeTruthy();
    await fill();
    expect(await screen.findByText('Customer selected')).toBeTruthy();
    expect(screen.getByText('1 product in stock')).toBeTruthy();
  });

  it('shows a warning about similar recent orders when the phone and items match', async () => {
    const api = orderApi();
    api.orders.checkDuplicates = vi.fn(
      async () =>
        [
          {
            orderId: 'o9',
            orderNumber: 1007,
            status: 'confirmed',
            createdAt: '2026-10-18T05:00:00.000Z',
            totalMinor: 1,
            reasons: ['Same item: TEE-1'],
          },
        ] as never,
    );
    mount(<NewOrderScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'New customer' }));
    await userEvent.type(await screen.findByLabelText(/^Phone/), '01712345678');
    expect(await screen.findByText('These recent orders look similar')).toBeTruthy();
    expect(screen.getByText('Same item: TEE-1')).toBeTruthy();
    expect(screen.getByText('This is only a hint. You can still save this order.')).toBeTruthy();
  });

  it('a read-only role is told it cannot create orders', async () => {
    mount(<NewOrderScreen />, orderApi(), 'ACCOUNTANT');
    expect(await screen.findByText('Your role can view orders but not create them.')).toBeTruthy();
  });
});

describe('customers', () => {
  const customer = (n: number) => ({
    id: `0197b0a0-0000-7000-8000-0000000000c${n}`,
    name: `Customer ${n}`,
    phone: '+8801712345678',
    email: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    stats: {
      ordersCount: n,
      deliveredCount: n,
      cancelledCount: 0,
      returnedCount: 0,
      deliveredValueMinor: n * 250_000,
      lastOrderAt: '2026-10-17T05:00:00.000Z',
    },
  });

  it('lists customers with plain counts and delivered value in taka, and finds nobody honestly', async () => {
    const list = vi.fn(async (q: { q?: string }) => ({
      items: q.q ? [] : [customer(1), customer(2)],
      nextCursor: null,
    }));
    mount(<CustomersScreen />, { customers: { list } });
    const row = await screen.findByRole('row', { name: /Customer 2/ });
    expect(within(row).getByText('৳5,000.00')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Search'), 'zzz');
    expect(await screen.findByText('No customers match')).toBeTruthy();
  });

  it('shows a customer’s counts and their orders with status and payment badges', async () => {
    const full = {
      ...customer(2),
      addresses: [
        {
          id: 'a1',
          label: 'Home',
          recipientName: 'Customer 2',
          phone: '+8801712345678',
          line1: 'House 5',
          area: 'Dhanmondi',
          district: 'Dhaka',
          division: 'Dhaka',
          postalCode: null,
          isDefault: true,
        },
      ],
    };
    const orders = vi.fn(async () => ({
      items: [summary(1, 'delivered', { payment: 'cod_collected' })],
      nextCursor: null,
      total: 1,
    }));
    mount(<CustomerDetailScreen id={full.id} />, {
      customers: { get: async () => full, orders },
    });
    expect(await screen.findByRole('heading', { name: 'Customer 2' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Delivered value: ৳5,000.00' })).toBeTruthy();
    const row = await screen.findByRole('row', { name: /#1001/ });
    expect(within(row).getByText('Delivered')).toBeTruthy();
    expect(within(row).getByText('COD · Collected')).toBeTruthy();
    expect(screen.getByText('House 5, Dhanmondi, Dhaka, Dhaka')).toBeTruthy();
    expect(screen.getByText(/never labels or scores a customer/)).toBeTruthy();
  });
});
