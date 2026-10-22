import type { APIRequestContext } from '@playwright/test';
import {
  API,
  createAccount,
  expect,
  expectAccessible,
  mailLink,
  PASSWORD,
  signInToApp,
  test,
  uniqueEmail,
} from './fixtures';
import { apiClient, openAccountMenu } from './support/ui';

/**
 * Erasing a customer, deleting an account, deleting a business (docs/privacy-and-deletion.md), through the real web app.
 * Technical behaviour only: nothing here is a claim about any law.
 */

/** A customer with one cancelled order (so they can be erased), made through the API. */
async function customerWithOrder(
  api: Awaited<ReturnType<typeof apiClient>>,
  name: string,
  phone: string,
  status: 'cancelled' | 'confirmed',
) {
  const sku = `ER-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const product = await api.post('/v1/products', {
    name: 'Cotton tee',
    variants: [{ sku, priceMinor: 100_000 }],
  });
  const variantId = product.variants[0].id as string;
  await api.post('/v1/inventory/receive', { variantId, quantity: 10 });
  const order = await api.post('/v1/orders', {
    customer: { name, phone },
    address: {
      recipientName: name,
      phone,
      line1: 'House 12, Road 5, Dhanmondi',
      area: 'Dhanmondi',
      district: 'Dhaka',
      division: 'Dhaka',
    },
    items: [{ variantId, quantity: 1 }],
    idempotencyKey: `er-${Math.random().toString(36).slice(2, 12)}`,
    confirm: status === 'confirmed',
  });
  if (status === 'cancelled')
    await api.post(`/v1/orders/${order.id}/status`, {
      status: 'cancelled',
      reason: 'Changed mind',
    });
  return order.customer.id as string;
}

/** Inviting people needs a verified email address: verify the owner's through the mailed link, as a person would. */
async function verifyEmail(request: APIRequestContext, email: string) {
  const token = (await mailLink(email, 'verify-email')).split('token=')[1]!;
  const res = await request.post(`${API}/v1/auth/verify-email`, { data: { token } });
  expect(res.ok(), await res.text()).toBe(true);
}

test.describe('erasing a customer', () => {
  test('is refused while an order is open, then erases the details and keeps the order', async ({
    page,
    request,
  }) => {
    const owner = await createAccount(request, 'erase');
    const api = await apiClient(request, owner.email);
    const customerId = await customerWithOrder(api, 'Rahim Uddin', '01712345678', 'confirmed');
    await signInToApp(page, owner.email);

    await page.goto(`/customers/${customerId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Rahim Uddin' })).toBeVisible();
    await expect(page.getByText(/Order totals, statuses and dates stay/)).toBeVisible();
    await expectAccessible(page);

    // an order is still open: the server refuses, and says how many
    await page.getByRole('button', { name: 'Erase personal data' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Type ERASE to confirm/).fill('ERASE');
    await dialog.getByRole('button', { name: 'Erase personal data' }).click();
    await expect(dialog.getByText(/1 order\(s\) in progress/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // cancel the order, then it works
    const orders = (await api.get(`/v1/customers/${customerId}/orders`)) as {
      items: { id: string }[];
    };
    await api.post(`/v1/orders/${orders.items[0]!.id}/status`, {
      status: 'cancelled',
      reason: 'Not needed',
    });
    await page.reload();
    await page.getByRole('button', { name: 'Erase personal data' }).click();
    // a wrong word does nothing
    await page
      .getByRole('dialog')
      .getByLabel(/Type ERASE to confirm/)
      .fill('erase');
    await page.getByRole('dialog').getByRole('button', { name: 'Erase personal data' }).click();
    await expect(page.getByText('Type ERASE exactly as shown')).toBeVisible();
    await page
      .getByRole('dialog')
      .getByLabel(/Type ERASE to confirm/)
      .fill('ERASE');
    await page.getByRole('dialog').getByRole('button', { name: 'Erase personal data' }).click();
    await expect(page.getByText('Personal data erased').first()).toBeVisible();

    // the customer is a placeholder now, with no way to change them
    await expect(page.getByRole('heading', { level: 1, name: 'Erased customer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Create order' })).toHaveCount(0);
    // the old name is nowhere on the orders either
    await page.goto('/orders');
    await expect(page.getByText('Rahim Uddin')).toHaveCount(0);
  });

  test('the customer list can be exported', async ({ page, request }) => {
    const owner = await createAccount(request, 'export');
    const api = await apiClient(request, owner.email);
    await customerWithOrder(api, 'Karim Hossain', '01898765432', 'cancelled');
    await signInToApp(page, owner.email);
    await page.goto('/customers');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export customers CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^customers-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

test.describe('deleting an account', () => {
  test('asks for the password again, then signs out for good and frees the email', async ({
    page,
    request,
  }) => {
    const owner = await createAccount(request, 'bye');
    await signInToApp(page, owner.email);
    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Your account' }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
    await expect(page.getByText(/signs you out everywhere/)).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Delete my account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Type DELETE to confirm/).fill('DELETE');
    await dialog.getByLabel('Your password').fill('Not-the-password-1!');
    await dialog.getByRole('button', { name: 'Delete my account' }).click();
    await expect(dialog.getByText('Incorrect password.')).toBeVisible();
    // still signed in
    await expect(page).toHaveURL(/\/account$/);

    await dialog.getByLabel('Your password').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Delete my account' }).click();
    await expect(page).toHaveURL(/\/login/);

    // it cannot be signed in to any more
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Incorrect email or password.')).toBeVisible();

    // and the same address can register again
    const again = await request.post(`${API}/v1/auth/register`, {
      headers: { 'x-client': 'web' },
      data: {
        name: 'Second Life',
        tenantName: 'Fresh Start Shop',
        email: owner.email,
        password: PASSWORD,
      },
    });
    expect(again.status()).toBe(201);
  });

  test('names the business that blocks it when its owner has other members', async ({
    page,
    request,
  }) => {
    const owner = await createAccount(request, 'blocked');
    await verifyEmail(request, owner.email);
    const api = await apiClient(request, owner.email);
    // a member, joined through an invitation
    const inviteeEmail = uniqueEmail('member');
    await api.post('/v1/members/invitations', { email: inviteeEmail, role: 'STAFF' });
    const link = await mailLink(inviteeEmail, 'accept-invitation');
    const accepted = await request.post(`${API}/v1/auth/accept-invitation`, {
      headers: { 'x-client': 'web' },
      data: {
        token: new URL(link).searchParams.get('token'),
        name: 'Helper Person',
        password: PASSWORD,
      },
    });
    expect(accepted.status()).toBe(201);

    await signInToApp(page, owner.email);
    await page.goto('/account');
    await page.getByRole('button', { name: 'Delete my account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Type DELETE to confirm/).fill('DELETE');
    await dialog.getByLabel('Your password').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Delete my account' }).click();
    await expect(dialog.getByText('Businesses that need another owner:')).toBeVisible();
    await expect(dialog.getByText(`• ${owner.shop}`)).toBeVisible();
    await expect(page).toHaveURL(/\/account$/); // nothing happened
  });
});

test.describe('deleting a business', () => {
  test('is requested with the name and password, blocks the app, and can be cancelled by the owner', async ({
    page,
    request,
  }) => {
    const owner = await createAccount(request, 'closing');
    await signInToApp(page, owner.email);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Delete this business' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export customers CSV' })).toBeVisible();

    await page.getByRole('button', { name: 'Delete this business' }).click();
    const dialog = page.getByRole('dialog');
    // a wrong name is refused before anything is sent
    await dialog.getByLabel(/Type the business name to confirm/).fill('Some other shop');
    await dialog.getByLabel('Your password').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Delete this business' }).click();
    await expect(dialog.getByText(`Type ${owner.shop} exactly as shown`)).toBeVisible();

    await dialog.getByLabel(/Type the business name to confirm/).fill(owner.shop);
    await dialog.getByRole('button', { name: 'Delete this business' }).click();

    // the app is replaced by the blocking screen, with the date and Cancel
    await expect(page.getByText(/is scheduled for deletion on/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel deletion' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' }).first()).toBeVisible();
    await expectAccessible(page);

    // everything else is closed, also straight from the address bar
    await page.goto('/orders');
    await expect(page.getByText(/is scheduled for deletion on/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Cancel deletion' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
    await page.goto('/settings');
    await expect(page.getByRole('button', { name: 'Delete this business' })).toBeVisible();
  });

  test('another member sees the blocking screen without a cancel button, and can sign out', async ({
    page,
    request,
  }) => {
    const owner = await createAccount(request, 'closing2');
    await verifyEmail(request, owner.email);
    const api = await apiClient(request, owner.email);
    const staffEmail = uniqueEmail('staff');
    await api.post('/v1/members/invitations', { email: staffEmail, role: 'STAFF' });
    const link = await mailLink(staffEmail, 'accept-invitation');
    await request.post(`${API}/v1/auth/accept-invitation`, {
      headers: { 'x-client': 'web' },
      data: {
        token: new URL(link).searchParams.get('token'),
        name: 'Staff Person',
        password: PASSWORD,
      },
    });
    const asked = await request.post(`${API}/v1/tenant/delete-request`, {
      headers: api.headers,
      data: { confirmName: owner.shop, password: PASSWORD },
    });
    expect(asked.status()).toBe(200);

    await signInToApp(page, staffEmail);
    await expect(page.getByText(/is scheduled for deletion on/)).toBeVisible();
    await expect(page.getByText(/Only an owner of the business can cancel/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel deletion' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out' }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('the public data-deletion page', () => {
  test('is reachable without signing in and says how to ask', async ({ page }) => {
    await page.goto('/data-deletion');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Data deletion instructions' }),
    ).toBeVisible();
    await expect(page.getByText(/Business integrations/)).toBeVisible();
    await expect(page.getByText(/Delete my account/)).toBeVisible();
    await expect(page.getByText(/not legal advice/)).toBeVisible();
    await expectAccessible(page);
  });
});
