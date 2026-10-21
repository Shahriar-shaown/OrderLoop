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
import { catalogCreateProduct } from './support/catalog-ui';
import { apiSession } from './support/ui';

/** The sentence the Integrations screen offers in its test tool: a Bangla order for the product made below. */
const ORDER_MESSAGE =
  'আমি ২টা Demo Cotton T-Shirt নিব, নাম রিনা, ০১৭১২৩৪৫৬৭৮, বাসা ১২ রোড ৫ মিরপুর ঢাকা';
/** A second customer asks for something that is not in the catalogue, so a person has to pick the product. */
const UNKNOWN_ITEM_MESSAGE =
  'আমি ১টা লাল পাঞ্জাবি নিব, নাম সুমন, ০১৮১২৩৪৫৬৭৮, বাসা ৩ রোড ২ গুলশান ঢাকা';
const MOCK_BANNER = 'Mock integration: not connected to Meta';

type Headers = { authorization: string };

/** A product the customers ask for, with stock to sell (confirming a draft reserves it). */
async function shopWithProduct(page: Page, request: APIRequestContext, prefix: string) {
  const account = await createAccount(request, prefix);
  await signInToApp(page, account.email);
  await catalogCreateProduct(page, {
    name: 'Demo Cotton T-Shirt',
    sku: 'DEMO-TEE-1',
    price: '850',
  });
  const headers = await apiSession(request, account.email);
  const found = await request.get(`${API}/v1/products`, { headers, params: { q: 'DEMO-TEE-1' } });
  const { items } = (await found.json()) as { items: { variants: { id: string }[] }[] };
  const received = await request.post(`${API}/v1/inventory/receive`, {
    headers,
    data: { variantId: items[0]!.variants[0]!.id, quantity: 20, reason: 'Opening stock' },
  });
  expect(received.status(), await received.text()).toBe(201);
  return { account, headers };
}

/** A mock account and one customer message, set up through the API (the screens are exercised elsewhere in this file). */
async function mockDraft(
  request: APIRequestContext,
  headers: Headers,
  text: string,
  sender: string,
) {
  const made = await request.post(`${API}/v1/integrations/meta/mock/connection`, {
    headers,
    data: {},
  });
  expect(made.status(), await made.text()).toBe(201);
  const { id: connectionId } = (await made.json()) as { id: string };
  const sent = await request.post(`${API}/v1/integrations/meta/mock/events`, {
    headers,
    data: { connectionId, senderId: sender, text, messageId: `e2e-${sender}-${Date.now()}` },
  });
  expect(sent.status(), await sent.text()).toBe(200);
  const { draftId } = (await sent.json()) as { draftId: string | null };
  expect(draftId, 'the message should have become a draft').toBeTruthy();
  return draftId!;
}

/** Send the sentence in the Integrations test tool (optionally changing the text or the sender first). */
async function sendTestMessage(page: Page, options: { text?: string; sender?: string } = {}) {
  if (options.text) await page.getByLabel('Customer message').fill(options.text);
  if (options.sender) await page.getByLabel('Sender id').fill(options.sender);
  await page.getByRole('button', { name: 'Send test message' }).click();
}

const draftRows = (page: Page) => page.getByRole('row', { name: /^Draft from/ });

test.describe('Facebook and Instagram messages (mock mode)', () => {
  test('an owner turns a Bangla chat message into an order, and sending it again changes nothing', async ({
    page,
    request,
  }) => {
    const { headers } = await shopWithProduct(page, request, 'meta-owner');

    // Integrations says loudly that this is a mock, and offers the tools to try it.
    await page.goto('/settings/integrations/meta');
    await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
    await expect(page.getByText(MOCK_BANNER)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect Facebook & Instagram' })).toBeDisabled();
    await expect(page.getByText('No accounts connected yet')).toBeVisible();
    await page.getByRole('button', { name: 'Add mock account' }).click();
    await expect(page.getByText('Active', { exact: true })).toBeVisible();

    // The prefilled Bangla message becomes a draft, and the screen links to it.
    await expect(page.getByLabel('Customer message')).toHaveValue(ORDER_MESSAGE);
    await sendTestMessage(page);
    await page.getByRole('link', { name: 'Open the draft' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Review draft order' })).toBeVisible();
    await expect(page.getByText(MOCK_BANNER)).toBeVisible();

    // What the customer wrote is shown word for word, next to the form made from it.
    await expect(page.getByText(ORDER_MESSAGE)).toBeVisible();
    await expect(page.getByLabel(/^Phone/)).toHaveValue('01712-345678');
    await expect(page.getByText(/Demo Cotton T-Shirt/).first()).toBeVisible();
    await expect(page.getByLabel('Quantity (DEMO-TEE-1)', { exact: true })).toHaveValue('2');

    // The name is read without the cue word: "নাম রিনা" ("name Rina") gives "রিনা", not the whole phrase.
    await expect(page.getByLabel('Customer name')).toHaveValue('রিনা');
    await page.getByLabel('Recipient name').fill('রিনা');
    // The thana is not something chat gives; the order form needs it.
    await page.getByLabel('Thana / upazila').fill('Mirpur');

    await page.getByRole('button', { name: 'Confirm order' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: /^#\d+$/ })).toBeVisible();
    await expect(page.getByText(/Demo Cotton T-Shirt/).first()).toBeVisible();
    await expect(page.getByText('01712-345678').first()).toBeVisible();

    // The order has the right customer, phone and items, with the catalogue's price.
    const orderId = page.url().split('/').pop()!;
    const order = await (await request.get(`${API}/v1/orders/${orderId}`, { headers })).json();
    expect(order.customer.phone).toBe('+8801712345678');
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({ quantity: 2, unitPriceMinor: 85_000 });

    // Sending the same message again creates nothing: not an event, not a draft, not an order.
    await page.goto('/settings/integrations/meta');
    await sendTestMessage(page);
    await expect(page.getByText(/already received. Nothing new was created/)).toBeVisible();
    await page.goto('/social-orders');
    await expect(page.getByRole('tab', { name: /^Needs review( 0)?$/ })).toBeVisible();
    await expect(page.getByText('No messages to review')).toBeVisible();
    await page.getByRole('tab', { name: /^Confirmed/ }).click();
    await expect(draftRows(page)).toHaveCount(1);
    await page.goto('/orders');
    await expect(page.getByText('1 order · 0 selected', { exact: true })).toBeVisible();
  });

  test('a second message from the same customer joins the open draft instead of starting another', async ({
    page,
    request,
  }) => {
    await shopWithProduct(page, request, 'meta-append');
    await page.goto('/settings/integrations/meta');
    await page.getByRole('button', { name: 'Add mock account' }).click();
    await sendTestMessage(page);
    await expect(page.getByRole('link', { name: 'Open the draft' })).toBeVisible();
    const more = 'ধানমন্ডি ঢাকা, আরও একটা Demo Cotton T-Shirt নিব, ০১৭১২৩৪৫৬৭৮';
    await sendTestMessage(page, { text: more });
    await expect(page.getByRole('link', { name: 'Open the draft' })).toBeVisible();

    await page.goto('/social-orders');
    await expect(draftRows(page)).toHaveCount(1);
    // The list hides most of the phone number.
    await expect(draftRows(page).first()).toContainText('017••••5678');
    await expect(draftRows(page).first()).not.toContainText('01712345678');
    await draftRows(page).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Review draft order' })).toBeVisible();
    await expect(page.getByText(ORDER_MESSAGE)).toBeVisible();
    await expect(page.getByText(more)).toBeVisible();
  });

  test('an item that matches nothing needs a person to pick the product before the order is made', async ({
    page,
    request,
  }) => {
    const { headers } = await shopWithProduct(page, request, 'meta-pick');
    const draftId = await mockDraft(request, headers, UNKNOWN_ITEM_MESSAGE, 'customer-sumon');
    await page.goto(`/social-orders/${draftId}`);
    await expect(page.getByText('Pick the product for these items')).toBeVisible();
    await page.getByLabel('Thana / upazila').fill('Gulshan');

    // Confirming is refused until the product is chosen.
    await page.getByRole('button', { name: 'Confirm order' }).click();
    await expect(
      page.getByText('Pick the product for every item the customer asked for, or remove it.'),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/social-orders/${draftId}$`));

    await page.getByRole('button', { name: /^Pick the product for/ }).click();
    await page.getByRole('searchbox', { name: /^Find a product for/ }).fill('Demo');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await expect(page.getByText('Pick the product for these items')).toHaveCount(0);
    await expect(page.getByLabel('Quantity (DEMO-TEE-1)', { exact: true })).toHaveValue('1');
    await page.getByRole('button', { name: 'Confirm order' }).click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
    await expect(page.getByText('01812-345678').first()).toBeVisible();
    const orderId = page.url().split('/').pop()!;
    const order = await (await request.get(`${API}/v1/orders/${orderId}`, { headers })).json();
    expect(order.items).toHaveLength(1);
    expect(order.customer.phone).toBe('+8801812345678');

    // The draft is closed now: it shows the facts and a link to the order, with nothing to change.
    await page.goto(`/social-orders/${draftId}`);
    await expect(page.getByText('This draft was confirmed')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open the order' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm order' })).toHaveCount(0);
  });

  test('a draft can be dismissed, with or without a reason', async ({ page, request }) => {
    const { headers } = await shopWithProduct(page, request, 'meta-dismiss');
    const draftId = await mockDraft(request, headers, ORDER_MESSAGE, 'customer-rina');
    await page.goto(`/social-orders/${draftId}`);
    await page.getByRole('button', { name: 'Dismiss draft' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Dismiss draft' }).click();
    await expect(page.getByText('This draft was dismissed')).toBeVisible();
    await page.goto('/social-orders');
    await page.getByRole('tab', { name: /^Dismissed/ }).click();
    await expect(draftRows(page)).toHaveCount(1);
  });

  test('an accountant sees drafts read-only and cannot confirm them, or open Integrations', async ({
    page,
    request,
    browser,
  }) => {
    // The owner verifies their email (needed to invite), makes a draft, and invites an accountant.
    const { account: owner, headers } = await shopWithProduct(page, request, 'meta-boss');
    const token = (await mailLink(owner.email, 'verify-email')).split('token=')[1]!;
    expect((await request.post(`${API}/v1/auth/verify-email`, { data: { token } })).ok()).toBe(
      true,
    );
    const draftId = await mockDraft(request, headers, ORDER_MESSAGE, 'customer-rina');
    const invitee = uniqueEmail('meta-accountant');
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

    // Social orders is in the menu; Integrations is not.
    await expect(guest.getByRole('link', { name: /^Social orders/ })).toBeVisible();
    await expect(guest.getByRole('link', { name: 'Integrations' })).toHaveCount(0);
    await guest.goto('/social-orders');
    await expect(guest.getByRole('row', { name: /^Draft from/ })).toHaveCount(1);
    await guest.goto(`/social-orders/${draftId}`);
    await expect(
      guest.getByText('Your role can look at drafts but not confirm or dismiss them.', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(guest.getByText(ORDER_MESSAGE)).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Confirm order' })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Dismiss draft' })).toHaveCount(0);

    await guest.goto('/settings/integrations/meta');
    await expect(guest.getByText('You do not have access to integrations')).toBeVisible();
    await context.close();
  });

  test('Integrations, the inbox and a draft pass the accessibility scan and fit a phone', async ({
    page,
    request,
  }) => {
    const { headers } = await shopWithProduct(page, request, 'meta-a11y');
    const draftId = await mockDraft(request, headers, ORDER_MESSAGE, 'customer-rina');
    for (const [path, heading] of [
      ['/settings/integrations/meta', 'Integrations'],
      ['/social-orders', 'Social orders'],
      [`/social-orders/${draftId}`, 'Review draft order'],
    ] as const) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.getByText(MOCK_BANNER)).toBeVisible();
      await expectAccessible(page);
      // Load the page again at phone width (as the other specs do) so the layout is measured after it has settled.
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test('Integrations explains a failed sign-in with Meta', async ({ page, request }) => {
    const account = await createAccount(request, 'meta-error');
    await signInToApp(page, account.email);
    await page.goto('/settings/integrations/meta?error=access_denied');
    await expect(page.getByText('Could not connect to Meta')).toBeVisible();
    await expect(page.getByText(/cancelled the sign-in with Meta/)).toBeVisible();
    await expect(page.getByText(MOCK_BANNER)).toBeVisible();
  });
});
