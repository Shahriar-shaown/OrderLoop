import { readFile } from 'node:fs/promises';
import type { APIRequestContext } from '@playwright/test';
import {
  API,
  createAccount,
  expect,
  expectAccessible,
  expectNoHorizontalOverflow,
  mailLink,
  PASSWORD,
  signInToApp,
  test,
  uniqueEmail,
} from './fixtures';
import {
  chooseFilter,
  expectStockOfSku,
  fillNewOrderForm,
  listSearch,
  orderHeading,
  ordersSummary,
  statusChip,
} from './support/ui';

/** Sign in through the API and put products on the shelf, so a scenario starts with something to sell. */
async function stockUp(
  request: APIRequestContext,
  email: string,
  items: { sku: string; name: string; price: number; qty: number }[],
) {
  const login = await request.post(`${API}/v1/auth/login`, {
    headers: { 'x-client': 'web' },
    data: { email, password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  const ids: Record<string, string> = {};
  for (const i of items) {
    const p = await request.post(`${API}/v1/products`, {
      headers,
      data: { name: i.name, variants: [{ sku: i.sku, priceMinor: i.price * 100 }] },
    });
    expect(p.status(), await p.text()).toBe(201);
    const variantId = ((await p.json()) as { variants: { id: string }[] }).variants[0]!.id;
    ids[i.sku] = variantId;
    if (i.qty > 0) {
      const r = await request.post(`${API}/v1/inventory/receive`, {
        headers,
        data: { variantId, quantity: i.qty },
      });
      expect(r.status()).toBe(201);
    }
  }
  return { headers, ids };
}

test.describe('orders', () => {
  test('take an order, confirm it, cancel it: totals and stock stay correct', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'orders');
    const { headers } = await stockUp(request, email, [
      { sku: 'TEE-1', name: 'Cotton tee', price: 850, qty: 10 },
    ]);
    await signInToApp(page, email);

    await page.getByRole('link', { name: 'Orders', exact: true }).first().click();
    await expect(page.getByText('No orders yet')).toBeVisible();
    await page.getByRole('link', { name: 'Create your first order' }).click();

    // an empty form says exactly what is missing
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByText('Choose a customer or enter their details')).toBeVisible();

    await fillNewOrderForm(page, {
      phone: '01712-345678',
      name: 'Rina Akter',
      sku: 'TEE-1',
      search: 'tee',
      qty: '2',
    });
    await page.getByLabel('Discount (৳)').fill('100');
    await page.getByLabel('Delivery charge (৳)').fill('60');
    await page.getByLabel('Advance paid (৳)').fill('200');
    // the estimate uses the same maths as the server
    await expect(
      page.getByText('An estimate. The final figures are worked out when you save.'),
    ).toBeVisible();
    await expect(page.getByText('৳1,660.00', { exact: true }).first()).toBeVisible(); // 1700 - 100 + 60
    await expect(page.getByText('৳1,460.00', { exact: true }).first()).toBeVisible(); // COD to collect
    await page.getByRole('button', { name: 'Save as draft' }).click();

    // the saved order shows the server's figures
    await expect(orderHeading(page, 1001)).toBeVisible();
    await expect(page.getByText('Pending confirmation').first()).toBeVisible();
    await expect(page.getByText('This order holds no stock yet')).toBeVisible();
    await expect(page.getByText('৳1,660.00').first()).toBeVisible();
    await expect(page.getByText('৳1,460.00').first()).toBeVisible();
    const orderUrl = page.url();

    // nothing is held yet
    await expectStockOfSku(request, headers, 'TEE-1', { onHand: 10, reserved: 0 });

    // confirm: stock is reserved
    await page.goto(orderUrl);
    await page.getByRole('button', { name: 'Confirm order' }).click();
    await expect(page.getByText('Stock is reserved for this order')).toBeVisible();
    await expectStockOfSku(request, headers, 'TEE-1', { onHand: 10, reserved: 2, available: 8 });

    // cancel needs a reason, then the stock comes back
    await page.goto(orderUrl);
    await page.getByRole('button', { name: 'Cancel order' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Cancel order' }).click();
    await expect(dialog.getByText('Say why (at least 3 characters)')).toBeVisible();
    await dialog.getByLabel('Reason').fill('Customer changed their mind');
    await dialog.getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByText('Cancelled').first()).toBeVisible();
    await expect(page.getByText('Customer changed their mind')).toBeVisible();
    // the timeline lists every step, in order
    const timeline = page.getByRole('list', { name: 'Order timeline' });
    await expect(timeline).toContainText('Order created');
    await expect(timeline).toContainText('Confirmed');
    await expect(timeline).toContainText('Cancelled');
    await expectStockOfSku(request, headers, 'TEE-1', { onHand: 10, reserved: 0 });
    // a cancelled order offers no more moves
    await page.goto(orderUrl);
    await expect(page.getByRole('button', { name: 'Confirm order' })).toHaveCount(0);
  });

  test('confirming without enough stock explains which item is short and changes nothing', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'short');
    const { headers } = await stockUp(request, email, [
      { sku: 'RARE-1', name: 'Rare vase', price: 500, qty: 1 },
    ]);
    await signInToApp(page, email);
    await fillNewOrderForm(page, {
      phone: '01712345678',
      name: 'Karim',
      sku: 'RARE-1',
      search: 'vase',
      qty: '3',
    });
    // the form already says the line is short; a draft holds no stock, so it can still be saved
    await expect(page.getByText(/only 1 available, 3 on this order/)).toBeVisible();
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(orderHeading(page, 1001)).toBeVisible();
    await page.getByRole('button', { name: 'Confirm order' }).click();
    await expect(page.getByText(/RARE-1: only 1 available, 3 needed/)).toBeVisible();
    await expect(page.getByText('Pending confirmation').first()).toBeVisible();
    await expectStockOfSku(request, headers, 'RARE-1', { onHand: 1, reserved: 0 });
  });

  test('the form warns about a repeat order and recognises a returning customer', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'repeat');
    await stockUp(request, email, [{ sku: 'MUG-1', name: 'Blue mug', price: 300, qty: 10 }]);
    await signInToApp(page, email);
    await fillNewOrderForm(page, {
      phone: '01712345678',
      name: 'Nasrin',
      sku: 'MUG-1',
      search: 'mug',
    });
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(orderHeading(page, 1001)).toBeVisible();

    await page.goto('/orders/new');
    await page.getByRole('button', { name: 'New customer' }).click();
    await page.getByLabel(/^Phone/).fill('+880 1712 345678');
    // a number already on file is that customer: picked, with plain counts and no verdict
    await expect(page.getByText('Repeat customer')).toBeVisible();
    await expect(page.getByText('Nasrin', { exact: true })).toBeVisible();
    await expect(page.getByText(/1 previous order/)).toBeVisible();
    await expect(page.getByText('These recent orders look similar')).toBeVisible();
    await expect(page.getByText(/ago for the same phone number/)).toBeVisible();
    await expect(
      page.getByText('This is only a hint. You can still save this order.'),
    ).toBeVisible();
    // there is no label or score about the customer anywhere
    await expect(page.getByText(/fraud|risky|blacklist|trust score/i)).toHaveCount(0);
  });

  test('pressing Create twice (or retrying) makes one order', async ({ page, request }) => {
    const { email } = await createAccount(request, 'twice');
    await stockUp(request, email, [{ sku: 'ONCE-1', name: 'Once only', price: 100, qty: 10 }]);
    await signInToApp(page, email);
    await fillNewOrderForm(page, {
      phone: '01712345678',
      name: 'Double Click',
      sku: 'ONCE-1',
      search: 'once',
    });
    await page.getByRole('button', { name: 'Save as draft' }).dblclick();
    await expect(orderHeading(page, 1001)).toBeVisible();
    await page.goto('/orders');
    await expect(ordersSummary(page, '1 order · 0 selected')).toBeVisible();
  });

  test('search, filter, sort, select and act on many orders at once', async ({ page, request }) => {
    const { email } = await createAccount(request, 'many');
    const { headers, ids } = await stockUp(request, email, [
      { sku: 'BULK-A', name: 'Alpha item', price: 100, qty: 50 },
      { sku: 'BULK-B', name: 'Beta item', price: 200, qty: 1 },
    ]);
    const make = async (
      name: string,
      phone: string,
      sku: string,
      qty: number,
      extra: object = {},
    ) => {
      const r = await request.post(`${API}/v1/orders`, {
        headers,
        data: {
          customer: { name, phone },
          address: {
            recipientName: name,
            phone,
            line1: 'Road 1',
            area: 'Sadar',
            district: 'Dhaka',
            division: 'Dhaka',
          },
          items: [{ variantId: ids[sku], quantity: qty }],
          idempotencyKey: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          ...extra,
        },
      });
      expect(r.status(), await r.text()).toBe(201);
    };
    await make('Anika Rahman', '01711000001', 'BULK-A', 1, { source: 'facebook' });
    await make('Bashir Ahmed', '01811000002', 'BULK-A', 2, { source: 'whatsapp' });
    await make('Chitra Sen', '01911000003', 'BULK-A', 3, { source: 'facebook' });
    await make('Dipu Roy', '01611000004', 'BULK-B', 5, { source: 'instagram' }); // more than exists

    await signInToApp(page, email);
    await page.goto('/orders');
    await expect(ordersSummary(page, '4 orders · 0 selected')).toBeVisible();

    // the status chips count every status
    await expect(page.getByRole('tab', { name: 'All 4' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Pending confirmation 4' })).toBeVisible();

    // search by name and by a fragment of the phone number
    await listSearch(page).fill('bashir');
    await expect(ordersSummary(page, '1 order · 0 selected')).toBeVisible();
    await expect(page.getByRole('cell', { name: /Bashir Ahmed/ })).toBeVisible();
    await listSearch(page).fill('01911');
    await expect(page.getByRole('cell', { name: /Chitra Sen/ })).toBeVisible();
    await listSearch(page).fill('');
    await expect(ordersSummary(page, '4 orders · 0 selected')).toBeVisible();

    // filter by source, then sort by total
    await chooseFilter(page, 'Source: All', 'Facebook');
    await expect(ordersSummary(page, '2 orders · 0 selected')).toBeVisible();
    await chooseFilter(page, 'Source: Facebook', 'All');
    await expect(ordersSummary(page, '4 orders · 0 selected')).toBeVisible();
    await chooseFilter(page, 'Sort: Newest first', 'Highest total');
    const firstRow = page.getByRole('row').nth(1);
    await expect(firstRow).toContainText('Dipu Roy'); // 5 x 200 = ৳1,000

    // select all shown and confirm in bulk: three confirm, the one without stock is reported, nothing else changes
    await page.getByRole('checkbox', { name: 'Select all rows' }).click();
    await expect(page.getByText('4 orders selected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('Some orders could not be updated')).toBeVisible();
    await expect(page.getByText(/BULK-B: only 1 available, 5 needed/)).toBeVisible();
    await expect(page.getByText('1 order selected', { exact: true })).toBeVisible(); // only the failed one stays selected
    await statusChip(page, 'Confirmed').click();
    await expect(ordersSummary(page, '3 orders · 0 selected')).toBeVisible();

    // bulk cancel needs a reason
    await page.getByRole('checkbox', { name: 'Select all rows' }).click();
    await page.getByRole('button', { name: 'Cancel…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Cancel orders' }).click();
    await expect(dialog.getByText('Say why (at least 3 characters)')).toBeVisible();
    await dialog.getByLabel('Reason').fill('Courier strike this week');
    await dialog.getByRole('button', { name: 'Cancel orders' }).click();
    await expect(page.getByText('No orders match')).toBeVisible();
    await statusChip(page, 'Cancelled').click();
    await expect(ordersSummary(page, '3 orders · 0 selected')).toBeVisible();
    await expectStockOfSku(request, headers, 'BULK-A', { onHand: 50, reserved: 0 });
  });

  test('orders download as CSV with the figures the server worked out', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'csv');
    await stockUp(request, email, [{ sku: 'CSV-1', name: 'Csv tee', price: 1250.5, qty: 5 }]);
    await signInToApp(page, email);
    await fillNewOrderForm(page, {
      phone: '01712345678',
      name: 'Csv Buyer',
      sku: 'CSV-1',
      search: 'csv',
      qty: '2',
    });
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(orderHeading(page, 1001)).toBeVisible();
    await page.goto('/orders');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^orders-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = await readFile((await file.path())!, 'utf8');
    expect(text).toContain('order_number,status,created_at,customer_name');
    expect(text).toMatch(
      /1001,pending_confirmation,.*Csv Buyer.*CSV-1.*,2,1250\.50,0\.00,2501\.00,/,
    );
  });

  test('an orders CSV is checked first, then imported once', async ({ page, request }) => {
    const { email } = await createAccount(request, 'imp');
    const { headers } = await stockUp(request, email, [
      { sku: 'IMP-1', name: 'Import item', price: 500, qty: 10 },
    ]);
    await signInToApp(page, email);
    await page.goto('/orders/import');
    const csv =
      'order_ref,customer_name,phone,address_line,area,district,division,sku,quantity\n' +
      'R-1,Good Buyer,01712345678,Road 1,Sadar,Dhaka,Dhaka,IMP-1,2\n' +
      'R-2,Bad Phone,123,Road 1,Sadar,Dhaka,Dhaka,IMP-1,1\n' +
      'R-3,Unknown Sku,01812345678,Road 1,Sadar,Dhaka,Dhaka,NOPE-1,1\n';
    await page.getByLabel('CSV').fill(csv);
    await page.getByRole('button', { name: 'Check file' }).click();
    await expect(page.getByText('1 orders to create')).toBeVisible();
    await expect(page.getByText('2 problems')).toBeVisible();
    await expect(page.getByText(/Row 3: phone is not a Bangladeshi mobile number/)).toBeVisible();
    await expect(page.getByText(/NOPE-1 is not in your catalog/)).toBeVisible();
    await expect(
      page.getByText(/They would total ৳1,000\.00\. Nothing has been created yet\./),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Import 1 good orders, skip the rest' }).click();
    await expect(page.getByText('Import finished')).toBeVisible();
    await expect(page.getByText(/1 created, 0 were already imported, 2 skipped/)).toBeVisible();

    // the same file again creates nothing
    await page.getByRole('button', { name: 'Check file' }).click();
    await expect(page.getByText('1 already imported')).toBeVisible();
    await expect(page.getByText('0 orders to create')).toBeVisible();

    await page.goto('/orders');
    await expect(ordersSummary(page, '1 order · 0 selected')).toBeVisible();
    await expect(page.getByRole('cell', { name: /Good Buyer/ })).toBeVisible();
    // an import holds no stock
    await expectStockOfSku(request, headers, 'IMP-1', { onHand: 10, reserved: 0 });
  });

  test('a customer page shows saved addresses and plain order counts', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'cust');
    await stockUp(request, email, [{ sku: 'CU-1', name: 'Customer item', price: 100, qty: 10 }]);
    await signInToApp(page, email);
    await fillNewOrderForm(page, {
      phone: '01712345678',
      name: 'Repeat Customer',
      sku: 'CU-1',
      search: 'customer item',
    });
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(orderHeading(page, 1001)).toBeVisible();
    await page.getByRole('link', { name: 'View profile' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Repeat Customer' })).toBeVisible();
    await expect(page.getByText('01712-345678').first()).toBeVisible();
    await expect(page.getByText('House 5, Road 3, Dhanmondi, Dhaka, Dhaka')).toBeVisible();
    await expect(page.getByText('OrderLoop never labels or scores a customer.')).toBeVisible();
    await expect(page.getByRole('link', { name: '#1001' })).toBeVisible();

    await page.getByRole('button', { name: 'Add address' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Label').fill('Office');
    await dialog.getByLabel(/^Address/).fill('Motijheel Commercial Area');
    await dialog.getByLabel('Thana / upazila').fill('Motijheel');
    await dialog.getByLabel('District').fill('Dhaka');
    await dialog.getByRole('button', { name: 'Add address' }).click();
    await expect(
      page.getByText('Motijheel Commercial Area, Motijheel, Dhaka, Dhaka'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Make default' }).click();
    await expect(page.getByText('Default', { exact: true })).toHaveCount(1);

    await page.getByRole('link', { name: 'Customers', exact: true }).first().click();
    await expect(page.getByRole('link', { name: 'Repeat Customer' })).toBeVisible();
  });

  test('an accountant can look at orders but not create or change them', async ({
    page,
    request,
    browser,
  }) => {
    const owner = await createAccount(request, 'boss3');
    await stockUp(request, owner.email, [
      { sku: 'ACC-1', name: 'Accounting item', price: 100, qty: 5 },
    ]);
    const token = (await mailLink(owner.email, 'verify-email')).split('token=')[1]!;
    await request.post(`${API}/v1/auth/verify-email`, { data: { token } });
    const login = await request.post(`${API}/v1/auth/login`, {
      headers: { 'x-client': 'web' },
      data: { email: owner.email, password: PASSWORD },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const invitee = uniqueEmail('accountant');
    await request.post(`${API}/v1/members/invitations`, {
      headers: { authorization: `Bearer ${accessToken}` },
      data: { email: invitee, role: 'ACCOUNTANT' },
    });
    await signInToApp(page, owner.email);
    await fillNewOrderForm(page, {
      phone: '01712345678',
      name: 'Seen Only',
      sku: 'ACC-1',
      search: 'accounting',
    });
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(orderHeading(page, 1001)).toBeVisible();
    const orderUrl = page.url();

    const context = await browser.newContext();
    const guest = await context.newPage();
    await guest.goto(await mailLink(invitee, 'accept-invitation'));
    await guest.getByLabel('Your name (new accounts only)').fill('Anwar Hossain');
    await guest.getByLabel('Password').fill(PASSWORD);
    await guest.getByRole('button', { name: 'Join workspace' }).click();
    await expect(guest).toHaveURL(/\/dashboard$/);
    await guest.goto('/orders');
    await expect(guest.getByRole('cell', { name: /Seen Only/ })).toBeVisible();
    await expect(guest.getByRole('link', { name: 'Create order' })).toHaveCount(0);
    await expect(guest.getByRole('link', { name: 'Import' })).toHaveCount(0);
    await expect(guest.getByRole('checkbox')).toHaveCount(0);
    await guest.goto(orderUrl);
    await expect(orderHeading(guest, 1001)).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Confirm order' })).toHaveCount(0);
    await expect(guest.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
    await guest.goto('/orders/new');
    await expect(guest.getByText('Your role can view orders but not create them.')).toBeVisible();
    await context.close();
  });

  test('the order screens pass the accessibility scan and fit a phone', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'a11y');
    await stockUp(request, email, [{ sku: 'AY-1', name: 'Scan item', price: 100, qty: 5 }]);
    await signInToApp(page, email);
    await fillNewOrderForm(page, {
      phone: '01712345678',
      name: 'Scan Buyer',
      sku: 'AY-1',
      search: 'scan item',
    });
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(orderHeading(page, 1001)).toBeVisible();
    const detail = page.url();
    await expectAccessible(page);
    const customer = await page.getByRole('link', { name: 'View profile' }).getAttribute('href');
    const pages = [
      '/orders',
      '/orders/new',
      '/orders/import',
      '/customers',
      detail,
      `${detail}/edit`,
      customer!,
    ];
    for (const path of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectAccessible(page);
    }
    await page.setViewportSize({ width: 375, height: 800 });
    for (const path of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
});
