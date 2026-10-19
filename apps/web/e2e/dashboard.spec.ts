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
import { statusChip } from './support/ui';

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

const GREETING = /^Good (morning|afternoon|evening), /;

test.describe('dashboard', () => {
  test('a new business sees a welcome with real next steps, zeros, and an honest profit note', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'dashnew');
    await signInToApp(page, email);
    await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
    await expect(page.getByText('Welcome. Your dashboard fills in as you work.')).toBeVisible();
    // one page title, not one heading per figure
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    for (const name of ['Add a product', 'Receive stock', 'Take an order'])
      await expect(page.getByRole('link', { name }).first()).toBeVisible();
    await expect(page.getByText('Nothing needs your attention right now.')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Total orders: 0' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Delivered orders: 0' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Delivery success: —' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Revenue (delivered): ৳0.00' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'COD outstanding: ৳0.00' })).toBeVisible();
    await expect(page.getByRole('group', { name: /^Net profit: / })).toBeVisible();
    // the page says what the figures mean: delivered is not paid, unsettled COD is never profit
    await expect(page.getByText(/unsettled COD is never profit/)).toBeVisible();
    await expect(page.getByText('No orders yet')).toBeVisible();
    // the charts say their numbers in words
    await expect(
      page.getByRole('img', { name: /^Sales and profit per day, .* to / }),
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
    }); // out for delivery
    await seed.order(tee, 5, { to: ['cancelled'] }); // left out of sales
    await seed.order(low, 1, {
      to: ['confirmed', 'ready_to_ship', 'shipped', 'in_transit', 'delivery_failed'],
    });

    await signInToApp(page, email);
    await expect(page.getByRole('group', { name: 'Total orders: 6' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Delivered orders: 1' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Delivery success: 50%' })).toBeVisible(); // 1 delivered of 1 + 1 failed
    await expect(
      page.getByRole('group', { name: /^Revenue \(delivered\): ৳2,000\.00/ }),
    ).toBeVisible();
    // delivered orders with no courier shipment are not tracked, so nothing is owed by a courier
    await expect(page.getByRole('group', { name: /^COD outstanding: ৳0\.00/ })).toBeVisible();
    // (1000 - 400) x 2, with no courier charges or recorded costs yet
    await expect(page.getByRole('group', { name: /^Net profit: ৳1,200\.00/ })).toBeVisible();

    // needs attention, with links that open the right filtered list
    await expect(page.getByText('Needs attention · 3 orders')).toBeVisible();
    await expect(page.getByRole('link', { name: '1 order waiting to be confirmed' })).toBeVisible();
    await expect(
      page.getByRole('link', { name: '1 confirmed order to pack and ship' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: '1 failed delivery to follow up' })).toBeVisible();
    await expect(page.getByRole('link', { name: '1 product running low on stock' })).toBeVisible();
    await expect(page.getByText('DASH-LOW · reorder at 10')).toBeVisible();
    await expect(page.getByText('1 left')).toBeVisible();

    // recent orders name real orders, newest first
    await expect(page.getByRole('link', { name: '#1006' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Recent orders' })).toBeVisible();
    // COD settlement links to reconciliation
    await expect(page.getByRole('link', { name: 'Reconcile' })).toHaveAttribute('href', '/cod');

    // a status link opens that filtered list, with the same count
    await page.getByRole('link', { name: '1 order waiting to be confirmed' }).click();
    await expect(page).toHaveURL(/\/orders\?status=pending_confirmation/);
    await expect(statusChip(page, 'Pending confirmation')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Showing 1–1 of 1 order', { exact: true })).toBeVisible();
    await page.goBack();
    await page.getByRole('link', { name: 'Delivered', exact: true }).click();
    await expect(statusChip(page, 'Delivered')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Showing 1–1 of 1 order', { exact: true })).toBeVisible();
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
    await expect(page.getByRole('group', { name: 'Total orders: 2' })).toBeVisible();
    // no made-up profit: a dash, and the reason
    await expect(page.getByRole('group', { name: /^Net profit: —/ })).toBeVisible();
    await expect(page.getByText(/Some delivered order lines have no cost price/)).toBeVisible();

    await expect(page.getByText('created in the last 7 days').first()).toBeVisible();
    await page.getByRole('tab', { name: '30 days' }).click();
    await expect(page.getByText('created in the last 30 days').first()).toBeVisible();
    await expect(page.getByRole('group', { name: 'Total orders: 2' })).toBeVisible();
    await page.getByRole('tab', { name: 'Today' }).click();
    await expect(page.getByText('created today').first()).toBeVisible();
    await expect(page.getByRole('group', { name: 'Total orders: 2' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /custom/i })).toHaveCount(0);
  });

  test('keeps each workspace’s numbers apart', async ({ page, request }) => {
    const { email, shop } = await createAccount(request, 'dashiso');
    const seed = await seeder(request, email);
    const v = await seed.product('ISO-1', 100, 10);
    await seed.order(v, 1);
    await signInToApp(page, email);
    await expect(page.getByRole('group', { name: 'Total orders: 1' })).toBeVisible();

    await page.goto('/workspaces/new');
    await page.getByLabel('Business name').fill('Second Shop');
    await page.getByRole('button', { name: 'Create business' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.goto('/dashboard');
    await expect(page.getByText('Welcome. Your dashboard fills in as you work.')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Total orders: 0' })).toBeVisible();

    // the business menu in the header lists both; choosing the first brings its numbers back
    await page.getByTestId('tenant-name').click();
    await page.getByRole('menuitem', { name: new RegExp(`^${shop}`) }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('group', { name: 'Total orders: 1' })).toBeVisible();
  });

  test('a failed load says so and recovers when retried', async ({ page, request, tolerate }) => {
    tolerate(/Failed to load resource: the server responded with a status of 500/);
    const { email } = await createAccount(request, 'dasherr');
    await signInToApp(page, email);
    await expect(page.getByRole('group', { name: 'Total orders: 0' })).toBeVisible();
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
    await page.getByRole('tab', { name: 'Today' }).click();
    await expect(page.getByRole('alert').getByRole('button', { name: 'Try again' })).toBeVisible();
    await page.unroute('**/v1/dashboard**');
    await page.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('group', { name: 'Total orders: 0' })).toBeVisible();
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
    await expect(
      guest.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Anwar$/ }),
    ).toBeVisible();
    await expect(guest.getByRole('group', { name: 'Total orders: 0' })).toBeVisible();
    await expect(guest.getByRole('link', { name: 'Create order' })).toHaveCount(0);
    await expect(guest.getByRole('link', { name: 'Take an order' })).toHaveCount(0);
    await expect(guest.getByRole('link', { name: 'Team & staff' })).toBeVisible(); // accountants may see the team
    await context.close();
  });

  test('works on a phone: a bottom bar with More, nothing overflows, and it passes the accessibility scan', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'dashphone');
    const seed = await seeder(request, email);
    const v = await seed.product('PH-1', 100, 5, { cost: 40, reorder: 10 });
    await seed.order(v, 1, { to: DELIVERED });
    await signInToApp(page, email);
    await expect(page.getByRole('group', { name: 'Total orders: 1' })).toBeVisible();
    await expectAccessible(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Total orders: 1' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
    // the menu is a bottom bar; everything else is under More
    const more = page.getByRole('button', { name: 'More' });
    await expect(more).toBeVisible();
    await expect(page.getByRole('link', { name: 'Customers', exact: true })).toBeHidden();
    await more.click();
    await page.getByRole('link', { name: 'Customers', exact: true }).click();
    await expect(page).toHaveURL(/\/customers$/);
    await expect(page.getByRole('link', { name: 'Customers', exact: true })).toBeHidden(); // the menu closed
  });
});

test.describe('analytics and profit', () => {
  test('shows figures with their sources, withholds profit with its reason, and lets an owner record a cost', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'analytics');
    const seed = await seeder(request, email);
    const withCost = await seed.product('AN-A', 500, 20, { cost: 200 });
    const noCost = await seed.product('AN-B', 500, 20);
    await seed.order(withCost, 1, { to: DELIVERED });
    await seed.order(noCost, 1, { to: DELIVERED });

    await signInToApp(page, email);
    await page.getByRole('link', { name: 'Analytics & profit' }).click();
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Analytics & profit' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    // a missing cost price is flagged, with a way to fix it
    await expect(page.getByText('1 delivered line has no cost price')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Fix costs' })).toHaveAttribute(
      'href',
      '/products',
    );

    // every figure says where it comes from
    const gross = page.getByRole('group', { name: /^Gross sales: ৳1,000\.00/ });
    await expect(gross).toBeVisible();
    await expect(gross.getByText('From your orders')).toBeVisible();
    const revenue = page.getByRole('group', { name: /^Delivered revenue: ৳1,000\.00/ });
    await expect(revenue.getByText('From your orders')).toBeVisible();

    // profit is withheld, with the reason, instead of a made-up number
    const profit = page.getByRole('group', { name: /^Net profit: —/ });
    await expect(profit).toBeVisible();
    await expect(profit.getByText('Worked out from the figures above')).toBeVisible();
    await expect(page.getByRole('group', { name: /^Profit margin: —/ })).toBeVisible();
    await expect(page.getByText('Net profit is not shown')).toBeVisible();
    await expect(
      page.getByText(/Some delivered order lines have no cost price/).first(),
    ).toBeVisible();
    await expect(page.getByText('Not counted as profit')).toBeVisible();
    await expect(page.getByText('Read this before you trust the figures')).toBeVisible();
    await expect(page.getByRole('group', { name: /^Profit waterfall/ })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Best-selling products' })).toBeVisible();

    // the period control offers exactly what the API can answer
    await page.getByRole('tab', { name: '30 days' }).click();
    await expect(page.getByRole('group', { name: /^Gross sales: ৳1,000\.00/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /custom/i })).toHaveCount(0);
    await expectAccessible(page);

    // an owner can record a cost
    await expect(page.getByText('Costs you recorded')).toBeVisible();
    await page.getByRole('button', { name: 'Record a cost' }).click();
    await page.getByLabel('Amount (৳)').fill('250');
    await page.getByLabel('What it was for').fill('Boxes and tape');
    await page.getByRole('button', { name: 'Record cost' }).click();
    await expect(page.getByText('Cost recorded')).toBeVisible();
    await expect(page.getByText('Boxes and tape')).toBeVisible();
  });
});
