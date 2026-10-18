import type { OrderDetail, OrderSummary } from '@orderloop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/mount';
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
  ...extra,
});

describe('orders list', () => {
  const list = (items: OrderSummary[]) =>
    vi.fn(async () => ({ items, nextCursor: null, total: items.length }));

  it('shows real rows from the API, with money formatted in taka and the status in words', async () => {
    const api = {
      orders: { list: list([summary(1, 'pending_confirmation'), summary(2, 'delivered')]) },
    };
    mount(<OrdersScreen />, api);
    const row = await screen.findByRole('row', { name: /#1001/ });
    expect(within(row).getByText('Buyer 1')).toBeTruthy();
    expect(within(row).getByText('Pending confirmation')).toBeTruthy();
    expect(within(row).getAllByText('৳1,000.00').length).toBeGreaterThan(0);
    expect(
      within(await screen.findByRole('row', { name: /#1002/ })).getByText('Delivered'),
    ).toBeTruthy();
    expect(screen.getByText('2 orders')).toBeTruthy();
  });

  it('sends filters, sort and search to the server as the API expects them', async () => {
    const orders = list([summary(1, 'confirmed')]);
    mount(<OrdersScreen />, { orders: { list: orders } });
    await screen.findByRole('row', { name: /#1001/ });
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'confirmed');
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'high');
    await userEvent.type(screen.getByLabelText('Search'), 'rina');
    await waitFor(() =>
      expect(orders).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'confirmed',
          sort: 'totalMinor',
          dir: 'desc',
          q: 'rina',
          limit: 25,
        }),
      ),
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
    expect(await screen.findByText('2 selected')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
    expect(bulk).toHaveBeenCalledWith({
      orderIds: ['0197b0a0-0000-7000-8000-000000000001', '0197b0a0-0000-7000-8000-000000000003'],
      status: 'confirmed',
    });
    expect(await screen.findByText(/only 1 available, 4 needed/)).toBeTruthy();
    expect(screen.getByText('1 selected')).toBeTruthy(); // only the failed one stays selected
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

  it('a role that cannot write sees no selection boxes and no way to create', async () => {
    mount(<OrdersScreen />, { orders: { list: list([summary(1, 'confirmed')]) } }, 'ACCOUNTANT');
    await screen.findByRole('row', { name: /#1001/ });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('New order')).toBeNull();
  });

  it('shows an honest empty state, and one for a search with no results', async () => {
    mount(<OrdersScreen />, { orders: { list: list([]) } });
    expect(await screen.findByText('No orders yet')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Search'), 'nobody');
    expect(await screen.findByText('No orders match')).toBeTruthy();
  });
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

describe('order page', () => {
  const api = (order: OrderDetail, extra: Record<string, unknown> = {}) => ({
    orders: {
      get: async () => order,
      duplicates: async () => [],
      changeStatus: vi.fn(async () => order),
      ...extra,
    },
  });

  it('shows the server’s totals, the cash-on-delivery amount and the status history', async () => {
    mount(
      <OrderDetailScreen id={detail('confirmed', []).id} />,
      api(detail('confirmed', ['ready_to_ship', 'cancelled'])),
    );
    expect(await screen.findByRole('heading', { name: 'Order #1001' })).toBeTruthy();
    expect(screen.getByText('৳1,661.00')).toBeTruthy(); // order total
    expect(screen.getByText('৳1,461.00')).toBeTruthy(); // cash on delivery
    expect(screen.getByText('−৳100.00')).toBeTruthy();
    expect(
      screen.getByText(
        'Stock is reserved for this order. Cancelling it puts the stock back on sale.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Order created')).toBeTruthy();
    expect(screen.getAllByText('Anwar', { exact: false }).length).toBeGreaterThan(1);
  });

  it('offers only the moves the state machine allows', async () => {
    mount(
      <OrderDetailScreen id="x" />,
      api(detail('shipped', ['in_transit', 'delivered', 'delivery_failed'])),
    );
    await screen.findByRole('heading', { name: 'Order #1001' });
    expect(screen.getByRole('button', { name: 'Mark in transit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark delivered' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull(); // the goods have left
    expect(screen.queryByRole('button', { name: 'Confirm order' })).toBeNull();
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

  it('a return asks for each line’s condition', async () => {
    const order = detail('return_requested', ['returned', 'delivered']);
    const o = api(order);
    mount(<OrderDetailScreen id={order.id} />, o);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark returned' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Condition: TEE-1 × 2'), 'DAMAGED');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Arrived torn');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark returned' }));
    await waitFor(() =>
      expect(o.orders.changeStatus).toHaveBeenCalledWith(
        order.id,
        expect.objectContaining({
          status: 'returned',
          returnedItems: [{ itemId: order.items[0]!.id, condition: 'DAMAGED' }],
        }),
      ),
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
    expect(screen.queryByText(/fraud|risk|blacklist/i)).toBeNull();
  });
});

describe('new order form', () => {
  const variant = {
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
  };
  const orderApi = (
    create = vi.fn(async () => ({ ...detail('pending_confirmation', ['confirmed']), id: 'new1' })),
  ) => ({
    customers: { list: async () => ({ items: [], nextCursor: null }), get: async () => null },
    products: {
      list: async () => ({
        items: [{ id: 'p', name: 'Cotton tee', variants: [variant] }],
        nextCursor: null,
      }),
    },
    orders: { create, checkDuplicates: vi.fn(async () => []) },
  });

  async function fill() {
    await screen.findByLabelText(/^Phone/);
    await userEvent.type(screen.getByLabelText(/^Phone/), '01712-345678');
    await userEvent.type(screen.getByLabelText('Customer name', { exact: false }), 'Rina Akter');
    await userEvent.type(screen.getByLabelText('Recipient name', { exact: false }), 'Rina Akter');
    await userEvent.type(screen.getByLabelText(/^Address/), 'House 5, Road 3');
    await userEvent.type(screen.getByLabelText('Thana / upazila', { exact: false }), 'Dhanmondi');
    await userEvent.type(screen.getByLabelText('District', { exact: false }), 'Dhaka');
    await userEvent.type(screen.getByLabelText('Add an item'), 'tee');
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
  }

  it('estimates the total as the person types, labelled as an estimate', async () => {
    mount(<NewOrderScreen />, orderApi());
    await fill();
    await userEvent.clear(screen.getByLabelText('Quantity (TEE-1)'));
    await userEvent.type(screen.getByLabelText('Quantity (TEE-1)'), '2');
    await userEvent.type(screen.getByLabelText('Discount (৳)'), '100');
    await userEvent.type(screen.getByLabelText('Delivery charge (৳)'), '60');
    await userEvent.type(screen.getByLabelText('Advance paid (৳)'), '200');
    expect(await screen.findByText('৳1,661.00')).toBeTruthy();
    expect(screen.getByText('৳1,461.00')).toBeTruthy();
    expect(
      screen.getByText('An estimate. The final figures are worked out when you save.'),
    ).toBeTruthy();
  });

  it('never sends a total: only quantities, prices and the three adjustments, with one idempotency key', async () => {
    const create = vi.fn(async () => ({
      ...detail('pending_confirmation', ['confirmed']),
      id: 'new1',
    }));
    const { navigation } = mount(<NewOrderScreen />, orderApi(create));
    await fill();
    await userEvent.type(screen.getByLabelText('Delivery charge (৳)'), '60');
    await userEvent.click(screen.getByRole('button', { name: 'Create order' }));
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
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/orders/new1'));
  });

  it('“Create and confirm” asks the server to reserve stock in the same step', async () => {
    const create = vi.fn(async () => ({ ...detail('confirmed', ['ready_to_ship']), id: 'new2' }));
    mount(<NewOrderScreen />, orderApi(create));
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Create and confirm' }));
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
    await userEvent.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const calls = create.mock.calls as unknown as [{ idempotencyKey: string }][];
    expect((calls[1]![0] as { idempotencyKey: string }).idempotencyKey).toBe(
      (calls[0]![0] as { idempotencyKey: string }).idempotencyKey,
    );
  });

  it('says what is missing before sending anything', async () => {
    const create = vi.fn();
    mount(<NewOrderScreen />, orderApi(create));
    await userEvent.click(await screen.findByRole('button', { name: 'Create order' }));
    expect(await screen.findByLabelText(/^Phone/)).toHaveProperty('ariaInvalid', 'true');
    expect(create).not.toHaveBeenCalled();
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
