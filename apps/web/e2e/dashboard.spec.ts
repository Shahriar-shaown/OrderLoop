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

/** A signed-in API session for seeding data the dashboard should then report. */
async function seeder(request: APIRequestContext, email: string) {
  const login = await request.post(`${API}/v1/auth/login`, {
    headers: { 'x-client': 'web' },
    data: { email, password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  const post = async (path: string, data: object, status = 201) => {
    const r = await request.post(`${API}${path}`, { headers, data });
    expect(r.status(), `${path}: ${await r.text()}`).toBe(status);
    return (await r.json()) as Record<string, never>;
  };
  let n = 0;
  return {
    async product(
      sku: string,
      price: number,
      qty: number,
      opts: { cost?: number; reorder?: number } = {},
    ) {
      const p = (await post('/v1/products', {
        name: `Item ${sku}`,
        variants: [
          {
            sku,
            priceMinor: price * 100,
            ...(opts.cost !== undefined ? { costMinor: opts.cost * 100 } : {}),
            reorderPoint: opts.reorder ?? 0,
          },
        ],
      })) as unknown as { variants: { id: string }[] };
      const variantId = p.variants[0]!.id;
      if (qty > 0) await post('/v1/inventory/receive', { variantId, quantity: qty });
      return variantId;
    },
    async order(variantId: string, qty: number, opts: { to?: string[]; extra?: object } = {}) {
      const o = (await post('/v1/orders', {
        customer: {
          name: 'Seeded Buyer',
          phone: `0171${String(2000000 + ++n + Math.floor(Math.random() * 90000)).slice(-7)}`,
        },
        address: {
          recipientName: 'Seeded Buyer',
          phone: '01712345678',
          line1: 'Road 1',
          area: 'Sadar',
          district: 'Dhaka',
          division: 'Dhaka',
        },
        items: [{ variantId, quantity: qty }],
        idempotencyKey: `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ...opts.extra,
      })) as unknown as { id: string };
      for (const status of opts.to ?? [])
        await post(`/v1/orders/${o.id}/status`, { status, reason: 'seeded by the test' }, 200);
      return o.id;
    },
  };
}
const DELIVERED = ['confirmed', 'ready_to_ship', 'shipped', 'in_transit', 'delivered'];

test.describe('dashboard', () => {
  test('a new business sees a welcome with real next steps, zeros, and an honest profit note', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'dashnew');
    await signInToApp(page, email);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Welcome. Your dashboard fills in as you work.')).toBeVisible();
    // one page title, not one heading per figure
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    for (const name of ['Add a product', 'Receive stock', 'Take an order'])
      await expect(page.getByRole('link', { name })).toBeVisible();
    await expect(page.getByText('Nothing needs your attention right now.')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Orders: 0' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Sales: ৳0.00', exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Average order: —' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Delivery success: —' })).toBeVisible();
    // no profit is shown without delivered orders with costs, and the page says why
    await expect(page.getByText('No delivered orders in this period yet.')).toBeVisible();
    await expect(page.getByText('Estimated gross profit')).toHaveCount(0);
    // the charts say their numbers in words
    await expect(
      page.getByRole('img', { name: /^Orders per day, .* to .*: .*0\.$/ }),
    ).toBeVisible();
    // every call-to-action goes somewhere
    await page.getByRole('link', { name: 'Add a product' }).click();
    await expect(page).toHaveURL(/\/products\/new$/);
  });

  test('shows the figures the backend works out, and each one leads to its list', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'dashfull');
    const seed = await seeder(request, email);
    const tee = await seed.product('DASH-TEE', 1000, 50, { cost: 400, reorder: 5 });
    const low = await seed.product('DASH-LOW', 200, 2, { reorder: 10 });
    await seed.order(tee, 2, { to: DELIVERED }); // delivered: ৳2,000
    await seed.order(tee, 1, { to: ['confirmed'] }); // ৳1,000 to pack
    await seed.order(tee, 3); // pending ৳3,000
    await seed.order(tee, 1, {
      to: ['confirmed', 'ready_to_ship', 'shipped'],
      extra: { advancePaidMinor: 30_000 },
    }); // out for delivery: COD ৳700
    await seed.order(tee, 5, { to: ['cancelled'] }); // left out of sales
    await seed.order(low, 1, {
      to: ['confirmed', 'ready_to_ship', 'shipped', 'in_transit', 'delivery_failed'],
    });

    await signInToApp(page, email);
    await expect(page.getByRole('group', { name: 'Orders: 6' })).toBeVisible();
    await expect(page.getByRole('group', { name: /^Sales: ৳7,200\.00/ })).toBeVisible(); // 2000+1000+3000+1000+200
    await expect(page.getByRole('group', { name: /^Delivered sales: ৳2,000\.00/ })).toBeVisible();
    await expect(
      page.getByRole('group', { name: /^Cash on delivery out: ৳700\.00/ }),
    ).toBeVisible();
    await expect(page.getByRole('group', { name: 'Delivery success: 50%' })).toBeVisible(); // 1 delivered of 1 + 1 failed
    await expect(page.getByRole('group', { name: /^Average order: ৳1,440\.00/ })).toBeVisible();

    // needs attention, with links that open the right filtered list
    await expect(page.getByText('Needs your attention')).toBeVisible();
    await expect(page.getByRole('link', { name: '1 order waiting to be confirmed' })).toBeVisible();
    await expect(page.getByRole('link', { name: '1 failed delivery to follow up' })).toBeVisible();
    await expect(page.getByRole('link', { name: '1 product running low on stock' })).toBeVisible();
    await expect(page.getByText('Item DASH-LOW')).toBeVisible();
    await expect(page.getByText('1 available')).toBeVisible();

    // profit is an estimate, labelled, and uses the recorded cost: (1000 - 400) x 2
    await expect(page.getByText('Estimate', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'Estimated gross profit: ৳1,200.00' }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Leaves out order discounts, delivery charges, courier fees, returns and taxes/,
      ),
    ).toBeVisible();

    // recent activity names real orders
    await expect(page.getByRole('link', { name: 'Order #1006' }).first()).toBeVisible();

    // a status link opens that filtered list, with the same count
    await page.getByRole('link', { name: '1 order waiting to be confirmed' }).click();
    await expect(page).toHaveURL(/\/orders\?status=pending_confirmation/);
    await expect(page.getByLabel('Status')).toHaveValue('pending_confirmation');
    await expect(page.getByText('1 order match', { exact: true })).toBeVisible();
    await page.goBack();
    await page.getByRole('link', { name: 'Delivered', exact: true }).click();
    await expect(page.getByLabel('Status')).toHaveValue('delivered');
    await expect(page.getByText('1 order match', { exact: true })).toBeVisible();
  });

  test('switching the period changes the figures, and profit is withheld when a cost is missing', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'dashperiod');
    const seed = await seeder(request, email);
    const withCost = await seed.product('PER-A', 500, 20, { cost: 200 });
    const noCost = await seed.product('PER-B', 500, 20);
    await seed.order(withCost, 1, { to: DELIVERED });
    await seed.order(noCost, 1, { to: DELIVERED });
    await signInToApp(page, email);
    await expect(page.getByText('1 of 2 delivered order lines have no cost price')).toBeVisible();
    await expect(page.getByText('Estimated gross profit')).toHaveCount(0);

    const chart = page.getByRole('img', { name: /^Orders per day/ });
    await expect(chart).toHaveAttribute('aria-label', /: .*2\.$/); // today carries both orders
    await page.getByRole('tab', { name: 'Last 30 days' }).click();
    await expect(page.getByText('in the last 30 days').first()).toBeVisible();
    await expect(page.getByRole('group', { name: 'Orders: 2' })).toBeVisible();
    await page.getByRole('tab', { name: 'Today' }).click();
    await expect(page.getByText('created today').first()).toBeVisible();
    await expect(page.getByRole('group', { name: 'Orders: 2' })).toBeVisible();
  });

  test('keeps each workspace’s numbers apart', async ({ page, request }) => {
    const { email } = await createAccount(request, 'dashiso');
    const seed = await seeder(request, email);
    const v = await seed.product('ISO-1', 100, 10);
    await seed.order(v, 1);
    await signInToApp(page, email);
    await expect(page.getByRole('group', { name: 'Orders: 1' })).toBeVisible();

    await page.goto('/workspaces/new');
    await page.getByLabel('Business name').fill('Second Shop');
    await page.getByRole('button', { name: 'Create business' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.goto('/dashboard');
    await expect(page.getByText('Welcome. Your dashboard fills in as you work.')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Orders: 0' })).toBeVisible();

    await page.getByLabel('Business', { exact: true }).selectOption({ index: 0 });
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('group', { name: 'Orders: 1' })).toBeVisible();
  });

  test('a failed load says so and recovers when retried', async ({ page, request, tolerate }) => {
    tolerate(/Failed to load resource: the server responded with a status of 500/);
    const { email } = await createAccount(request, 'dasherr');
    await signInToApp(page, email);
    await page.route('**/v1/dashboard**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'x',
          title: 'internal_error',
          status: 500,
          code: 'internal_error',
        }),
      }),
    );
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByRole('tab', { name: 'Today' }).click();
    await expect(page.getByRole('alert').getByRole('button', { name: 'Try again' })).toBeVisible();
    await page.unroute('**/v1/dashboard**');
    await page.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('group', { name: 'Orders: 0' })).toBeVisible();
  });

  test('an accountant sees the same figures but no way to create orders', async ({
    page,
    request,
    browser,
  }) => {
    const owner = await createAccount(request, 'dashacct');
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
    void page;
    const context = await browser.newContext();
    const guest = await context.newPage();
    await guest.goto(await mailLink(invitee, 'accept-invitation'));
    await guest.getByLabel('Your name (new accounts only)').fill('Anwar Hossain');
    await guest.getByLabel('Password').fill(PASSWORD);
    await guest.getByRole('button', { name: 'Join workspace' }).click();
    await expect(guest).toHaveURL(/\/dashboard$/);
    await expect(guest.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(guest.getByRole('link', { name: 'New order' })).toHaveCount(0);
    await expect(guest.getByRole('link', { name: 'Team' })).toBeVisible(); // accountants may see the team
    await context.close();
  });

  test('works on a phone: the menu folds away, nothing overflows, and it passes the accessibility scan', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'dashphone');
    const seed = await seeder(request, email);
    const v = await seed.product('PH-1', 100, 5, { cost: 40, reorder: 10 });
    await seed.order(v, 1, { to: DELIVERED });
    await signInToApp(page, email);
    await expectAccessible(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('link', { name: 'Customers', exact: true })).toBeHidden();
    await menu.click();
    await expect(page.getByRole('button', { name: 'Close menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await page.getByRole('link', { name: 'Customers', exact: true }).click();
    await expect(page).toHaveURL(/\/customers$/);
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    ); // closes after navigating
  });
});
