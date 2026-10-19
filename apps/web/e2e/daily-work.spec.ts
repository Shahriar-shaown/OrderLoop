import { readFile } from 'node:fs/promises';
import type { Locator } from '@playwright/test';
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
import {
  apiSession,
  expectStockOfSku,
  fillNewOrderForm,
  listSearch,
  orderHeading,
  ordersSummary,
  signOutViaMenu,
} from './support/ui';

/**
 * The checkpoint: a seller's whole day, done only through the web screens against the real API. Nothing here seeds the
 * database or calls the API directly (the one email link is opened the way a person would, from the message).
 */
test('a seller can run a day of work from the dashboard, from sign-up to a delivered order', async ({
  page,
  browser,
  request,
}) => {
  const email = uniqueEmail('daily');

  // ---- sign up and verify ---------------------------------------------------------------------------------------------
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Rina Akter');
  await page.getByLabel('Business name').fill('Rina Fashion');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('Welcome. Your dashboard fills in as you work.')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Rina$/ }),
  ).toBeVisible();
  await page.goto(await mailLink(email, 'verify-email'));
  await expect(page.getByText('Your email address is verified')).toBeVisible();
  await page.getByRole('link', { name: 'Continue to OrderLoop' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // ---- business settings ----------------------------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await page.getByLabel('Contact phone').fill('01712-345678');
  await page.getByLabel('City').fill('Dhaka');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Business settings saved')).toBeVisible();

  // ---- a second workspace, and back ------------------------------------------------------------------------------------
  await page.goto('/workspaces/new');
  await page.getByLabel('Business name').fill('Rina Outlet');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByLabel('Business name')).toHaveValue('Rina Outlet');
  await page.getByRole('button', { name: /Switch business$/ }).click();
  await page.getByRole('menuitem', { name: /Rina Fashion/ }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('tenant-name')).toHaveText('Rina Fashion');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByTestId('user-email')).toHaveText(email);
  await page.keyboard.press('Escape');

  // ---- supplier and product -------------------------------------------------------------------------------------------
  await page.goto('/suppliers');
  await page.getByRole('button', { name: 'New supplier' }).click();
  const supplier = page.getByRole('dialog');
  await supplier.getByLabel('Supplier name').fill('Dhaka Weavers');
  await supplier.getByRole('button', { name: 'Add supplier' }).click();
  await expect(page.getByRole('cell', { name: /Dhaka Weavers/ })).toBeVisible();

  await page.goto('/products/new');
  await page.getByLabel('Product name').fill('Handloom panjabi');
  await page.getByLabel('Supplier').selectOption({ label: 'Dhaka Weavers' });
  await page.getByLabel('SKU').fill('pan-m');
  await page.getByLabel('Size').fill('M');
  await page.getByLabel('Price (৳)').fill('1200');
  await page.getByLabel('Cost (৳)').fill('700');
  await page.getByLabel('Reorder at').fill('3');
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Handloom panjabi' })).toBeVisible();

  // bring stock in through the product page
  const row = page.getByRole('row', { name: /PAN-M/i });
  await row.getByRole('button', { name: 'Receive', exact: true }).click();
  const receive = page.getByRole('dialog');
  await receive.getByLabel('Quantity').fill('10');
  await receive.getByRole('button', { name: 'Receive stock' }).click();
  const headers = await apiSession(request, email);
  await expectStockOfSku(request, headers, 'PAN-M', { onHand: 10, reserved: 0 });

  // ---- take, confirm and deliver an order -------------------------------------------------------------------------------
  await fillNewOrderForm(page, {
    phone: '01712-345678',
    name: 'Nasrin Sultana',
    sku: 'PAN-M',
    search: 'panjabi',
    qty: '2',
    line1: 'House 5, Road 3, Dhanmondi',
  });
  await page.getByLabel('Delivery charge (৳)').fill('60');
  await expect(page.getByText('৳2,460.00', { exact: true }).first()).toBeVisible(); // 2 x 1200 + 60
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await expect(orderHeading(page, 1001)).toBeVisible();
  await expect(page.getByText('Stock is reserved for this order')).toBeVisible();
  const first = page.url();
  for (const [button, status] of [
    ['Mark ready to ship', 'Ready to ship'],
    ['Mark shipped', 'Shipped'],
    ['Mark in transit', 'In transit'],
    ['Mark delivered', 'Delivered'],
  ] as const) {
    await page.getByRole('button', { name: button }).click();
    await expect(page.getByRole('list', { name: 'Order timeline' })).toContainText(status);
  }
  await expect(page.getByRole('button', { name: 'Request return' })).toBeVisible();
  // the cash tiles keep the three words apart: delivered is not collected
  await expect(page.getByRole('group', { name: 'Expected: ৳2,460.00' })).toBeVisible();
  await expect(page.getByRole('group', { name: /^Collected: ৳0\.00/ })).toBeVisible();

  // ---- a second order, cancelled: stock returns ------------------------------------------------------------------------
  await fillNewOrderForm(page, {
    phone: '01812345678',
    name: 'Karim Uddin',
    sku: 'PAN-M',
    search: 'panjabi',
    qty: '3',
    line1: 'Village Sadar',
    area: 'Sadar',
    district: 'Cumilla',
  });
  await page.getByLabel('Division').selectOption('Chattogram');
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await expect(orderHeading(page, 1002)).toBeVisible();
  const second = page.url();
  await expectStockOfSku(request, headers, 'PAN-M', { onHand: 8, reserved: 3 }); // 10 - 2 delivered; 3 held for 1002
  await page.goto(second);
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const cancel = page.getByRole('dialog');
  await cancel.getByLabel('Reason').fill('Customer could not be reached');
  await cancel.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
  await expectStockOfSku(request, headers, 'PAN-M', { onHand: 8, reserved: 0, available: 8 });

  // ---- the dashboard reflects all of it ---------------------------------------------------------------------------------
  await page.goto('/dashboard');
  await expect(page.getByRole('group', { name: 'Total orders: 2' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Delivered orders: 1' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Delivery success: 100%' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Revenue (delivered): ৳2,460.00' })).toBeVisible(); // the cancelled order is left out
  const recent = page.getByRole('table', { name: 'Recent orders' });
  await expect(recent.getByRole('link', { name: '#1002' })).toBeVisible();
  await expect(recent.getByRole('link', { name: '#1001' })).toBeVisible();
  await expectAccessible(page);

  // ---- the orders list: search, then export ---------------------------------------------------------------------------
  await page.goto('/orders');
  await listSearch(page).fill('nasrin');
  await expect(ordersSummary(page, '1 order · 0 selected')).toBeVisible();
  await listSearch(page).fill('');
  await expect(ordersSummary(page, '2 orders · 0 selected')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const csv = await readFile((await (await download).path())!, 'utf8');
  expect(csv).toContain('1001,delivered');
  expect(csv).toContain('1002,cancelled');
  await page.goto(first);
  await expect(page.getByText('Delivered').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'View profile' })).toBeVisible();

  // ---- the team: invite, change a role, revoke, remove (with confirmation) --------------------------------------------
  await page.getByRole('link', { name: 'Team & staff', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Team & staff' })).toBeVisible();
  await expect(page.getByText('Your role: Owner.')).toBeVisible();
  const invitee = uniqueEmail('helper');
  const invite = page; // the invitation form is part of the page
  await invite.getByLabel('Email').fill('not-an-email');
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(invite.getByText('Enter a valid email address')).toBeVisible();
  await invite.getByLabel('Email').fill(invitee);
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('cell', { name: invitee, exact: true })).toBeVisible();

  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(await mailLink(invitee, 'accept-invitation'));
  await guest.getByLabel('Your name (new accounts only)').fill('Helper Person');
  await guest.getByLabel('Password').fill(PASSWORD);
  await guest.getByRole('button', { name: 'Join workspace' }).click();
  await expect(guest).toHaveURL(/\/dashboard$/);
  await expect(guest.getByRole('group', { name: 'Total orders: 2' })).toBeVisible(); // same business, same numbers
  // staff cannot see the team list, so the menu does not offer it; the page itself says so
  await expect(guest.getByRole('link', { name: 'Team & staff', exact: true })).toHaveCount(0);
  await guest.goto('/team');
  await expect(guest.getByText('Your role: Staff.')).toBeVisible();
  await expect(guest.getByText('Your role cannot see the team list.')).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Send invitation' })).toHaveCount(0);
  await expect(guest.getByRole('button', { name: /Actions for/ })).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: 'Actions for Helper Person' }).click();
  await page.getByRole('menuitem', { name: 'Change role' }).click();
  const role = page.getByRole('dialog');
  await role.getByLabel('Role', { exact: true }).selectOption('MANAGER');
  await role.getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByText('Helper Person is now manager')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Helper Person' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByText('They lose access to this business immediately.')).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click(); // backing out changes nothing
  await expect(page.getByText('Helper Person', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Helper Person' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Helper Person was removed')).toBeVisible();
  await expect(page.getByText('Helper Person', { exact: true })).toHaveCount(0);
  // the removed person is out on their very next action
  await guest.goto('/dashboard');
  await expect(guest).toHaveURL(/\/login/);
  await context.close();

  // ---- sign out and back in: everything is still there ------------------------------------------------------------------
  await signOutViaMenu(page);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('group', { name: 'Total orders: 2' })).toBeVisible();
});

test('the team page explains roles, shows the real permission matrix, and asks before revoking an invitation', async ({
  page,
  request,
}) => {
  const { email } = await createAccount(request, 'teampage');
  const token = (await mailLink(email, 'verify-email')).split('token=')[1]!;
  await request.post(`${API}/v1/auth/verify-email`, { data: { token } });
  await signInToApp(page, email);
  await page.goto('/team');
  await expect(page.getByRole('heading', { level: 1, name: 'Team & staff' })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'What each role can do' }),
  ).toBeVisible();
  const matrix = page.getByRole('table', { name: 'Permissions by role' });
  // Each role cell holds a check or minus icon named Yes / No.
  const answer = (row: Locator, column: number) =>
    row.getByRole('cell').nth(column).getByRole('img');
  const settings = matrix.getByRole('row', { name: /Change business settings/ });
  await expect(answer(settings, 1)).toHaveAccessibleName('Yes'); // owner
  await expect(answer(settings, 2)).toHaveAccessibleName('Yes'); // admin
  await expect(answer(settings, 3)).toHaveAccessibleName('No'); // manager
  await expect(answer(settings, 5)).toHaveAccessibleName('No'); // accountant
  const orders = matrix.getByRole('row', { name: /Create and change orders/ });
  await expect(answer(orders, 4)).toHaveAccessibleName('Yes'); // staff
  await expect(answer(orders, 5)).toHaveAccessibleName('No'); // accountant
  await expect(page.getByText('No pending invitations')).toBeVisible();
  await expectAccessible(page);

  // invite, then revoke: the dialog asks first, and backing out changes nothing
  const invitee = uniqueEmail('revoked');
  await page.getByLabel('Email').fill(invitee);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('cell', { name: invitee, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Revoke invitation for ${invitee}` }).click();
  await expect(
    page.getByRole('dialog').getByText(`The link sent to ${invitee} stops working.`),
  ).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('cell', { name: invitee, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Revoke invitation for ${invitee}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('Invitation revoked')).toBeVisible();
  await expect(page.getByText('No pending invitations')).toBeVisible();
});
