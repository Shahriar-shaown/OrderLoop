import { readFile } from 'node:fs/promises';
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

/**
 * The checkpoint: a seller's whole day, done only through the web screens against the real API. Nothing here seeds the
 * database or calls the API directly (the one email link is opened the way a person would, from the message).
 */
test('a seller can run a day of work from the dashboard, from sign-up to a delivered order', async ({
  page,
  browser,
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
  await page.goto(await mailLink(email, 'verify-email'));
  await expect(page.getByText('Your email address is verified')).toBeVisible();
  await page.getByRole('link', { name: 'Continue to OrderLoop' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // ---- business settings ----------------------------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
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
  await page.getByLabel('Business', { exact: true }).selectOption({ label: 'Rina Fashion' });
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('user-email')).toHaveText(email);

  // ---- supplier and product -------------------------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Suppliers', exact: true }).click();
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
  await expect(row.getByRole('cell').nth(2)).toHaveText('10');

  // ---- take, confirm and deliver an order -------------------------------------------------------------------------------
  await page.goto('/orders/new');
  await page.getByLabel(/^Phone/).fill('01712-345678');
  await page.getByLabel('Customer name').fill('Nasrin Sultana');
  await page.getByLabel('Recipient name').fill('Nasrin Sultana');
  await page.getByLabel(/^Address/).fill('House 5, Road 3, Dhanmondi');
  await page.getByLabel('Thana / upazila').fill('Dhanmondi');
  await page.getByLabel('District').fill('Dhaka');
  await page.getByLabel('Add an item').fill('panjabi');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await page.getByLabel('Quantity (PAN-M)').fill('2');
  await page.getByLabel('Delivery charge (৳)').fill('60');
  await expect(page.getByText('৳2,460.00', { exact: true }).first()).toBeVisible(); // 2 x 1200 + 60
  await page.getByRole('button', { name: 'Create and confirm' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Order #1001/ })).toBeVisible();
  await expect(page.getByText('Stock is reserved for this order')).toBeVisible();
  const first = page.url();
  for (const [button, status] of [
    ['Mark ready to ship', 'Ready to ship'],
    ['Mark shipped', 'Shipped'],
    ['Mark in transit', 'In transit'],
    ['Mark delivered', 'Delivered'],
  ] as const) {
    await page.getByRole('button', { name: button }).click();
    await expect(page.getByText(status).first()).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Request return' })).toBeVisible();

  // ---- a second order, cancelled: stock returns ------------------------------------------------------------------------
  await page.goto('/orders/new');
  await page.getByLabel(/^Phone/).fill('01812345678');
  await page.getByLabel('Customer name').fill('Karim Uddin');
  await page.getByLabel('Recipient name').fill('Karim Uddin');
  await page.getByLabel(/^Address/).fill('Village Sadar');
  await page.getByLabel('Thana / upazila').fill('Sadar');
  await page.getByLabel('District').fill('Cumilla');
  await page.getByLabel('Division').selectOption('Chattogram');
  await page.getByLabel('Add an item').fill('panjabi');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await page.getByLabel('Quantity (PAN-M)').fill('3');
  await page.getByRole('button', { name: 'Create and confirm' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Order #1002/ })).toBeVisible();
  const second = page.url();
  await page.goto('/inventory');
  let cells = page.getByRole('row', { name: /PAN-M/i }).getByRole('cell');
  await expect(cells.nth(2)).toHaveText('8'); // 10 - 2 delivered
  await expect(cells.nth(3)).toHaveText('3'); // reserved for order 1002
  await page.goto(second);
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const cancel = page.getByRole('dialog');
  await cancel.getByLabel('Reason').fill('Customer could not be reached');
  await cancel.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
  await page.goto('/inventory');
  cells = page.getByRole('row', { name: /PAN-M/i }).getByRole('cell');
  await expect(cells.nth(2)).toHaveText('8');
  await expect(cells.nth(3)).toHaveText('0');
  await expect(cells.nth(4)).toHaveText('8');

  // ---- the dashboard reflects all of it ---------------------------------------------------------------------------------
  await page.goto('/dashboard');
  await expect(page.getByRole('group', { name: 'Orders: 2' })).toBeVisible();
  await expect(page.getByRole('group', { name: /^Sales: ৳2,460\.00/ })).toBeVisible(); // the cancelled order is left out
  await expect(page.getByRole('group', { name: /^Delivered sales: ৳2,460\.00/ })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Delivery success: 100%' })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Estimated gross profit: ৳1,000.00' }),
  ).toBeVisible(); // (1200 - 700) x 2
  await expect(page.getByText('Estimate', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Order #1002' }).first()).toBeVisible();
  await expect(page.getByText('Customer could not be reached')).toBeVisible();
  await expectAccessible(page);

  // ---- the orders list: search, then export ---------------------------------------------------------------------------
  await page.goto('/orders');
  await page.getByLabel('Search').fill('nasrin');
  await expect(page.getByText('1 order match', { exact: true })).toBeVisible();
  await page.getByLabel('Search').fill('');
  await expect(page.getByText('2 orders', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const csv = await readFile((await (await download).path())!, 'utf8');
  expect(csv).toContain('1001,delivered');
  expect(csv).toContain('1002,cancelled');
  await page.goto(first);
  await expect(page.getByText('Delivered').first()).toBeVisible();

  // ---- the team: invite, change a role, revoke, remove (with confirmation) --------------------------------------------
  await page.getByRole('link', { name: 'Team', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Team and permissions' })).toBeVisible();
  await expect(page.getByText('Your role: Owner.')).toBeVisible();
  const invitee = uniqueEmail('helper');
  await page.getByRole('button', { name: 'Invite someone' }).click();
  const invite = page.getByRole('dialog');
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
  await expect(guest.getByRole('group', { name: 'Orders: 2' })).toBeVisible(); // same business, same numbers
  // staff cannot see the team list, so the menu does not offer it; the page itself says so
  await expect(guest.getByRole('link', { name: 'Team', exact: true })).toHaveCount(0);
  await guest.goto('/team');
  await expect(guest.getByText('Your role: Staff.')).toBeVisible();
  await expect(guest.getByText('Your role cannot see the team list.')).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Invite someone' })).toHaveCount(0);
  await expect(guest.getByRole('button', { name: /Change role for/ })).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: 'Change role for Helper Person' }).click();
  const role = page.getByRole('dialog');
  await role.getByLabel('Role', { exact: true }).selectOption('MANAGER');
  await role.getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByText('Helper Person is now manager')).toBeVisible();
  await page.getByRole('button', { name: 'Remove Helper Person' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByText('They lose access to this business immediately.')).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click(); // backing out changes nothing
  await expect(page.getByText('Helper Person', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Helper Person' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Helper Person was removed')).toBeVisible();
  await expect(page.getByText('Helper Person', { exact: true })).toHaveCount(0);
  // the removed person is out on their very next action
  await guest.goto('/dashboard');
  await expect(guest).toHaveURL(/\/login/);
  await context.close();

  // ---- sign out and back in: everything is still there ------------------------------------------------------------------
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('group', { name: 'Orders: 2' })).toBeVisible();
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
  await expect(
    page.getByRole('heading', { level: 2, name: 'What each role can do' }),
  ).toBeVisible();
  const matrix = page.getByRole('table', { name: 'Permissions by role' });
  const owner = matrix.getByRole('row', { name: /Change business settings/ });
  await expect(owner.getByRole('cell').nth(1)).toHaveText('Yes'); // owner
  await expect(owner.getByRole('cell').nth(2)).toHaveText('Yes'); // admin
  await expect(owner.getByRole('cell').nth(3)).toHaveText('No'); // manager
  await expect(owner.getByRole('cell').nth(5)).toHaveText('No'); // accountant
  const orders = matrix.getByRole('row', { name: /Create and change orders/ });
  await expect(orders.getByRole('cell').nth(4)).toHaveText('Yes'); // staff
  await expect(orders.getByRole('cell').nth(5)).toHaveText('No'); // accountant
  await expect(page.getByText('No pending invitations')).toBeVisible();
  await expectAccessible(page);

  // invite, then revoke: the dialog asks first, and backing out changes nothing
  const invitee = uniqueEmail('revoked');
  await page.getByRole('button', { name: 'Invite someone' }).click();
  await page.getByRole('dialog').getByLabel('Email').fill(invitee);
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click();
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
