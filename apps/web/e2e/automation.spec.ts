import type { APIRequestContext, Page } from '@playwright/test';
import {
  API,
  createAccount,
  expect,
  mailLink,
  PASSWORD,
  signInToApp,
  test,
  uniqueEmail,
} from './fixtures';
import { catalogCreateProduct } from './support/catalog-ui';
import { apiSession } from './support/ui';

const LOW = 'Low stock';

/** The Low stock rule's card on the Automation page. */
const lowStockCard = (page: Page) => page.getByRole('group', { name: LOW });

/** The bell in the header: its name carries the unread count, so the badge is checked through the name. */
const bell = (page: Page, unread?: number) =>
  page.getByRole('link', {
    name: unread === undefined ? 'Notifications' : `Notifications, ${unread} unread`,
    exact: true,
  });

/** A product with a reorder point of 5 and 20 units on the shelf (so nothing is low yet), made through the screens and the API. */
async function productWithStock(page: Page, request: APIRequestContext, email: string) {
  await catalogCreateProduct(page, { name: 'Alert vase', sku: 'ALRT-1', reorder: '5' });
  const headers = await apiSession(request, email);
  const found = await request.get(`${API}/v1/products`, { headers, params: { q: 'ALRT-1' } });
  const { items } = (await found.json()) as { items: { variants: { id: string }[] }[] };
  const variantId = items[0]!.variants[0]!.id;
  const received = await request.post(`${API}/v1/inventory/receive`, {
    headers,
    data: { variantId, quantity: 20, reason: 'Opening stock' },
  });
  expect(received.status(), await received.text()).toBe(201);
  return {
    /** Stock falls below the reorder point of 5. */
    runLow: async () => {
      const res = await request.post(`${API}/v1/inventory/adjust`, {
        headers,
        data: { variantId, delta: -17, reason: 'Stock take' },
      });
      expect(res.status(), await res.text()).toBe(201);
    },
  };
}

/** Switch the Low stock rule on with its defaults (each product's own reorder point) and save it. */
async function switchOnLowStock(page: Page) {
  await page.goto('/automation');
  const card = lowStockCard(page);
  await card.getByRole('switch', { name: 'Switched on' }).click();
  await card.getByRole('button', { name: 'Save changes' }).click();
  await expect(card.getByText('On', { exact: true })).toBeVisible();
}

const runNow = (page: Page) => lowStockCard(page).getByRole('button', { name: 'Run now' });

test.describe('automation and notifications', () => {
  test('an owner sets up low stock, runs it, finds the alert in the bell and follows it to the low-stock list', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'alerts');
    await signInToApp(page, email);
    const stock = await productWithStock(page, request, email);
    await expect(bell(page)).toBeVisible();

    // Nothing is configured yet: the rule is off, with its defaults shown.
    await page.goto('/automation');
    await expect(page.getByRole('heading', { level: 1, name: 'Automation' })).toBeVisible();
    await expect(lowStockCard(page).getByText('Not set up yet')).toBeVisible();
    await expect(runNow(page)).toBeDisabled();

    await switchOnLowStock(page);

    // Stock is above the reorder point, so a run finds nothing to say.
    await runNow(page).click();
    await expect(lowStockCard(page).getByText('Run finished')).toBeVisible();
    await expect(lowStockCard(page).getByText(/New notifications: 0\./)).toBeVisible();
    await expect(bell(page)).toBeVisible();

    // Stock drops below the reorder point; running again announces it once.
    await stock.runLow();
    await runNow(page).click();
    await expect(lowStockCard(page).getByText(/New notifications: 1\./)).toBeVisible();
    await expect(bell(page, 1)).toBeVisible();

    // The bell opens the list; the new alert is marked as new, and tapping it opens the low-stock list.
    await bell(page, 1).click();
    await expect(page).toHaveURL(/\/notifications$/);
    const alert = page.getByRole('button', { name: /Low stock: 1 item/ });
    await expect(alert).toBeVisible();
    await expect(alert.getByText('New', { exact: true })).toBeVisible();
    await expect(alert).toContainText('Alert vase (ALRT-1): 3 left');
    await alert.click();
    await expect(page).toHaveURL(/\/products\?tab=low$/);
    await expect(page.getByRole('tab', { name: /^Low stock/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('cell', { name: /Alert vase/ })).toBeVisible();

    // Reading it cleared the badge.
    await expect(bell(page)).toBeVisible();
    await page.goto('/notifications');
    await expect(page.getByRole('button', { name: /Low stock: 1 item/ })).toBeVisible();
    await expect(page.getByText('New', { exact: true })).toHaveCount(0);

    // Pressing Run now again changes nothing: the product is still low, but it was already announced.
    await page.goto('/automation');
    await runNow(page).click();
    await expect(lowStockCard(page).getByText(/New notifications: 0\./)).toBeVisible();
    await expect(bell(page)).toBeVisible();
    await page.goto('/notifications');
    await expect(page.getByRole('button', { name: /Low stock: 1 item/ })).toHaveCount(1);
  });

  test('a person who turns off in-app alerts gets none from the next run', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'quiet');
    await signInToApp(page, email);
    const stock = await productWithStock(page, request, email);
    await switchOnLowStock(page);

    await page.goto('/notifications/preferences');
    const group = page.getByRole('group', { name: LOW });
    const inApp = group.getByRole('switch', { name: 'In the app' });
    await expect(inApp).toHaveAttribute('aria-checked', 'true');
    await inApp.click();
    await expect(inApp).toHaveAttribute('aria-checked', 'false');

    // The choice is saved on the server, not only on the screen.
    await page.reload();
    await expect(
      page.getByRole('group', { name: LOW }).getByRole('switch', { name: 'In the app' }),
    ).toHaveAttribute('aria-checked', 'false');

    await stock.runLow();
    await page.goto('/automation');
    await runNow(page).click();
    await expect(lowStockCard(page).getByText('Run finished')).toBeVisible();

    await expect(bell(page)).toBeVisible();
    await page.goto('/notifications');
    await expect(page.getByText('You are all caught up')).toBeVisible();
    await expect(page.getByRole('button', { name: /Low stock/ })).toHaveCount(0);
  });

  test('an accountant cannot see or change the rules, but still chooses their own alerts', async ({
    page,
    request,
    browser,
  }) => {
    // The owner verifies their email (needed to invite), then invites an accountant.
    const owner = await createAccount(request, 'boss');
    const token = (await mailLink(owner.email, 'verify-email')).split('token=')[1]!;
    expect((await request.post(`${API}/v1/auth/verify-email`, { data: { token } })).ok()).toBe(
      true,
    );
    const headers = await apiSession(request, owner.email);
    const invitee = uniqueEmail('books');
    const invite = await request.post(`${API}/v1/members/invitations`, {
      headers,
      data: { email: invitee, role: 'ACCOUNTANT' },
    });
    expect(invite.status(), await invite.text()).toBe(201);

    // The owner has the rule on.
    await signInToApp(page, owner.email);
    await switchOnLowStock(page);

    const context = await browser.newContext();
    const guest = await context.newPage();
    await guest.goto(await mailLink(invitee, 'accept-invitation'));
    await guest.getByLabel('Your name (new accounts only)').fill('Anwar Hossain');
    await guest.getByLabel('Password').fill(PASSWORD);
    await guest.getByRole('button', { name: 'Join workspace' }).click();
    await expect(guest).toHaveURL(/\/dashboard$/);

    // No Automation in the menu, and the page itself says why there is nothing to change.
    await expect(guest.getByRole('link', { name: 'Automation', exact: true })).toHaveCount(0);
    await guest.goto('/automation');
    await expect(guest.getByText('You do not have access to automation')).toBeVisible();
    await expect(guest.getByRole('switch')).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Run now' })).toHaveCount(0);

    // Their own alerts are theirs to choose (an accountant may see stock, orders and finances, so every kind is open to them).
    await guest.goto('/notifications/preferences');
    const cod = guest.getByRole('group', { name: 'Cash on delivery differences' });
    await expect(cod.getByRole('switch', { name: 'In the app' })).toBeEnabled();
    const stockAlerts = guest.getByRole('group', { name: LOW });
    await expect(stockAlerts.getByRole('switch', { name: 'In the app' })).toBeEnabled();
    await context.close();
  });
});
