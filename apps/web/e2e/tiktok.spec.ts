import type { APIRequestContext, Page } from '@playwright/test';
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
  catalogStockAction,
  catalogCreateProduct,
  expectCatalogVariantCell as expectCell,
} from './support/catalog-ui';
import { apiSession } from './support/ui';

const MOCK_BANNER = 'Mock integration: not connected to TikTok';
const SKU = 'TT-TEE-1';
const INTEGRATION = '/settings/integrations/tiktok-shop';

type Headers = { authorization: string };

/** An owner with a product that has 20 units on hand. Returns where the product's page is, to read its stock. */
async function shopWithProduct(page: Page, request: APIRequestContext, prefix: string) {
  const account = await createAccount(request, prefix);
  await signInToApp(page, account.email);
  await catalogCreateProduct(page, { name: 'Mock tee', sku: SKU, price: '500' });
  const productPage = page.url();
  await catalogStockAction(page, SKU, 'Receive', { Quantity: '20' });
  await expectCell(page, SKU, 'On hand', '20');
  return { account, productPage };
}

/** Check the product's stock on its page: the numbers a person reads on the stock screen. */
async function expectStock(
  page: Page,
  productPage: string,
  stock: { onHand: string; reserved: string; available: string },
) {
  await page.goto(productPage);
  await expectCell(page, SKU, 'On hand', stock.onHand);
  await expectCell(page, SKU, 'Reserved', stock.reserved);
  await expectCell(page, SKU, 'Available', stock.available);
}

/** Send a test order from the Integrations page's mock tool. */
async function sendTestOrder(
  page: Page,
  o: { sku?: string; quantity?: string; price?: string; status?: string },
) {
  if (o.sku) await page.getByLabel('SKU', { exact: true }).fill(o.sku);
  if (o.quantity) await page.getByLabel('Quantity').fill(o.quantity);
  if (o.price) await page.getByLabel(/^Unit price/).fill(o.price);
  if (o.status) await page.getByLabel('Order status').selectOption({ label: o.status });
  await page.getByRole('button', { name: 'Send test order' }).click();
  await expect(page.getByText('Order received.')).toBeVisible();
}

/** A mock shop and one order, made through the API (the screens are exercised elsewhere in this file). */
async function mockOrder(
  request: APIRequestContext,
  headers: Headers,
  item: { skuId: string; quantity: number },
) {
  const made = await request.post(`${API}/v1/integrations/tiktok-shop/mock/connection`, {
    headers,
    data: {},
  });
  expect(made.status(), await made.text()).toBe(201);
  const { id: connectionId } = (await made.json()) as { id: string };
  const sent = await request.post(`${API}/v1/integrations/tiktok-shop/mock/orders`, {
    headers,
    data: {
      connectionId,
      status: 'AWAITING_SHIPMENT',
      items: [{ ...item, sellerSku: item.skuId, unitPriceMinor: 1250 }],
    },
  });
  expect(sent.status(), await sent.text()).toBe(200);
  const { orderId } = (await sent.json()) as { orderId: string };
  return orderId;
}

/** The body rows of the list: the header row's name also starts with "TikTok order" (its first column), so it needs a cell. */
const orderRow = (page: Page) =>
  page.getByRole('row', { name: /^TikTok order / }).filter({ has: page.getByRole('cell') });
/** The text of the whole page: no taka sign may be in it on a TikTok screen. */
const pageText = (page: Page) => page.evaluate(() => document.body.innerText);

test.describe('TikTok Shop (mock mode)', () => {
  test('an owner follows an order from reserved to shipped, cancels another, and maps an unknown SKU', async ({
    page,
    request,
  }) => {
    const { productPage } = await shopWithProduct(page, request, 'tt-owner');

    // Integrations says loudly that this is a mock, says what OrderLoop does, and offers the tools to try it.
    await page.goto(INTEGRATION);
    await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
    await expect(page.getByText(MOCK_BANNER)).toBeVisible();
    await expect(page.getByText(/never changes anything on TikTok/).first()).toBeVisible();
    await expect(page.getByText(/has not been tested with TikTok/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect TikTok Shop' })).toBeDisabled();
    await expect(page.getByText('No shops connected yet')).toBeVisible();
    await page.getByRole('button', { name: 'Add mock shop' }).click();
    await expect(page.getByText('Active', { exact: true })).toBeVisible();

    // The SKU of the test order starts as a real SKU from the catalogue.
    await expect(page.getByLabel('SKU', { exact: true })).toHaveValue(SKU);

    // An order awaiting shipment reserves its stock: 3 of 20 are no longer available.
    await sendTestOrder(page, { quantity: '3', price: '12.50' });
    await expect(page.getByText(/Stock is held for this order/)).toBeVisible();
    await expectStock(page, productPage, { onHand: '20', reserved: '3', available: '17' });

    await page.goto('/tiktok-orders');
    await expect(page.getByRole('heading', { level: 1, name: 'TikTok orders' })).toBeVisible();
    await expect(page.getByText(MOCK_BANNER)).toBeVisible();
    await expect(orderRow(page)).toHaveCount(1);
    await expect(orderRow(page).first()).toContainText('Stock reserved');
    await expect(orderRow(page).first()).toContainText('Awaiting shipment');
    // The amount is in the shop's currency, written with its code, and never as taka.
    await expect(orderRow(page).first()).toContainText(/MYR 37\.50/);
    expect(await pageText(page)).not.toContain('৳');

    // IN_TRANSIT ships it: the reservation is fulfilled, so on hand falls and reserved goes back to nothing.
    await page.goto(INTEGRATION);
    await page.getByRole('button', { name: /^Move to In transit, order / }).click();
    await expect(page.getByText('Order moved to In transit')).toBeVisible();
    await expectStock(page, productPage, { onHand: '17', reserved: '0', available: '17' });
    await page.goto('/tiktok-orders');
    await expect(orderRow(page).first()).toContainText('Stock shipped');

    // A second order is cancelled before it ships: its stock is given back.
    await page.goto(INTEGRATION);
    await sendTestOrder(page, { quantity: '2' });
    await expectStock(page, productPage, { onHand: '17', reserved: '2', available: '15' });
    await page.goto(INTEGRATION);
    await page
      .getByRole('group', { name: /^Test order / })
      .filter({ hasText: 'Stock reserved' })
      .getByRole('button', { name: /^Cancel order / })
      .click();
    await expect(page.getByText('Order moved to Cancelled')).toBeVisible();
    await expectStock(page, productPage, { onHand: '17', reserved: '0', available: '17' });
    await page.goto('/tiktok-orders');
    await expect(orderRow(page).filter({ hasText: 'Stock released' })).toHaveCount(1);

    // An order for a SKU OrderLoop does not know waits: nothing moves, and it says it needs mapping.
    await page.goto(INTEGRATION);
    await sendTestOrder(page, { sku: 'UNKNOWN-SKU-9', quantity: '1' });
    await expect(page.getByText(/is not linked to one of yours/)).toBeVisible();
    await expectStock(page, productPage, { onHand: '17', reserved: '0', available: '17' });
    await page.goto('/tiktok-orders');
    await page.getByRole('tab', { name: /^Needs mapping/ }).click();
    await expect(orderRow(page)).toHaveCount(1);
    await expect(orderRow(page).first()).toContainText('Needs mapping');

    // The order's page says why, and the SKU mapping links it to the product: then its stock is reserved.
    await orderRow(page).first().click();
    await expect(
      page.getByText('Waiting for you to map 1 item: no stock has been moved.'),
    ).toBeVisible();
    await expect(page.getByText('Not mapped')).toBeVisible();
    await page.goto('/tiktok-orders/sku-mapping');
    const sku = page.getByRole('group', { name: 'TikTok SKU UNKNOWN-SKU-9' });
    await expect(sku.getByText('1 waiting order')).toBeVisible();
    await sku.getByRole('button', { name: 'Map to a product: SKU UNKNOWN-SKU-9' }).click();
    await page
      .getByRole('searchbox', { name: 'Find a product for SKU UNKNOWN-SKU-9' })
      .fill('Mock tee');
    await page.getByRole('button', { name: 'Use this product' }).first().click();
    await page.getByRole('button', { name: 'Save mapping, SKU UNKNOWN-SKU-9' }).click();
    await expect(page.getByText('1 waiting order was processed')).toBeVisible();
    await expect(page.getByText('Nothing to map')).toBeVisible();
    await expectStock(page, productPage, { onHand: '17', reserved: '1', available: '16' });
    await page.goto('/tiktok-orders');
    await page.getByRole('tab', { name: /^Reserved/ }).click();
    await expect(orderRow(page)).toHaveCount(1);
    expect(await pageText(page)).not.toContain('৳');
  });

  test('the menu shows TikTok orders with the number that need a person, and the reservation is labelled', async ({
    page,
    request,
  }) => {
    await shopWithProduct(page, request, 'tt-badge');
    await page.goto(INTEGRATION);
    await page.getByRole('button', { name: 'Add mock shop' }).click();
    await expect(page.getByLabel('SKU', { exact: true })).toHaveValue(SKU);
    await sendTestOrder(page, { sku: 'UNKNOWN-SKU-8', quantity: '1' });
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: /^TikTok orders/ })).toContainText('1');

    // A TikTok reservation in the inventory is labelled, links to its order and cannot be released by hand.
    await page.goto(INTEGRATION);
    await sendTestOrder(page, { sku: SKU, quantity: '2' });
    await page.goto('/products');
    await page.getByRole('tab', { name: /^Reservations/ }).click();
    await expect(page.getByText('TikTok order', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open the order' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Release' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fulfil' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Open the order' }).click();
    await expect(page).toHaveURL(/\/tiktok-orders\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Stock reserved').first()).toBeVisible();
  });

  test('an accountant can look at TikTok orders and SKUs but cannot map them', async ({
    page,
    request,
    browser,
  }) => {
    const { account } = await shopWithProduct(page, request, 'tt-boss');
    const token = (await mailLink(account.email, 'verify-email')).split('token=')[1]!;
    expect((await request.post(`${API}/v1/auth/verify-email`, { data: { token } })).ok()).toBe(
      true,
    );
    const headers = await apiSession(request, account.email);
    await mockOrder(request, headers, { skuId: 'UNKNOWN-SKU-7', quantity: 1 });
    const invitee = uniqueEmail('tt-accountant');
    const invite = await request.post(`${API}/v1/members/invitations`, {
      headers,
      data: { email: invitee, role: 'ACCOUNTANT' },
    });
    expect(invite.status(), await invite.text()).toBe(201);

    const context = await browser.newContext();
    const guest = await context.newPage();
    await guest.goto(await mailLink(invitee, 'accept-invitation'));
    await guest.getByLabel('Your name (new accounts only)').fill('Anwar Hossain');
    await guest.getByLabel('Password').fill(PASSWORD);
    await guest.getByRole('button', { name: 'Join workspace' }).click();
    await expect(guest).toHaveURL(/\/dashboard$/);

    await expect(guest.getByRole('link', { name: /^TikTok orders/ })).toBeVisible();
    await expect(guest.getByRole('link', { name: 'Integrations' })).toHaveCount(0);
    await guest.goto('/tiktok-orders');
    await expect(orderRow(guest)).toHaveCount(1);
    await guest.goto('/tiktok-orders/sku-mapping');
    await expect(guest.getByRole('group', { name: 'TikTok SKU UNKNOWN-SKU-7' })).toBeVisible();
    await expect(
      guest.getByText('Your role can look at SKU links but not change them.'),
    ).toBeVisible();
    await expect(guest.getByRole('button', { name: /Map to a product/ })).toHaveCount(0);

    await guest.goto('/tiktok-orders');
    await orderRow(guest).first().click();
    await expect(guest.getByText(/Someone who can change inventory has to map it/)).toBeVisible();
    await guest.goto(INTEGRATION);
    await expect(guest.getByText('You do not have access to integrations')).toBeVisible();
    await context.close();
  });

  test('the integration, the orders, an order and the SKU mapping pass the accessibility scan and fit a phone', async ({
    page,
    request,
  }) => {
    const { account } = await shopWithProduct(page, request, 'tt-a11y');
    const headers = await apiSession(request, account.email);
    const orderId = await mockOrder(request, headers, { skuId: 'UNKNOWN-SKU-6', quantity: 2 });
    for (const [path, heading] of [
      [INTEGRATION, 'Integrations'],
      ['/tiktok-orders', 'TikTok orders'],
      [`/tiktok-orders/${orderId}`, null],
      ['/tiktok-orders/sku-mapping', 'TikTok orders'],
    ] as const) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      await expect(
        page.getByRole('heading', { level: 1, ...(heading ? { name: heading } : {}) }),
      ).toBeVisible();
      await expect(page.getByText(MOCK_BANNER)).toBeVisible();
      await expectAccessible(page);
      // Load the page again at phone width (as the other specs do) so the layout is measured after it has settled.
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(path);
      await expect(
        page.getByRole('heading', { level: 1, ...(heading ? { name: heading } : {}) }),
      ).toBeVisible();
      await expect(page.getByText(MOCK_BANNER)).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test('the two channels switch from the top of each Integrations page, and a failed sign-in is explained', async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, 'tt-switch');
    await signInToApp(page, account.email);
    await page.goto('/settings/integrations/meta');
    await page.getByRole('tab', { name: 'TikTok Shop' }).click();
    await expect(page).toHaveURL(/\/settings\/integrations\/tiktok-shop$/);
    await expect(page.getByText(MOCK_BANNER)).toBeVisible();
    await page.getByRole('tab', { name: 'Facebook and Instagram' }).click();
    await expect(page).toHaveURL(/\/settings\/integrations\/meta$/);

    await page.goto(`${INTEGRATION}?error=access_denied`);
    await expect(page.getByText('Could not connect to TikTok Shop')).toBeVisible();
    await expect(page.getByText(/cancelled or refused/)).toBeVisible();
    await page.goto(`${INTEGRATION}?error=tiktok_unavailable`);
    await expect(page.getByText(/TikTok could not be reached right now/)).toBeVisible();
  });
});
