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

test.describe('roles shape the screens', () => {
  test('an invited accountant can look but not change', async ({ page, request, browser }) => {
    // The owner verifies their email (needed to invite), then invites an accountant.
    const owner = await createAccount(request, 'boss');
    const token = (await mailLink(owner.email, 'verify-email')).split('token=')[1]!;
    expect((await request.post(`${API}/v1/auth/verify-email`, { data: { token } })).ok()).toBe(
      true,
    );
    const login = await request.post(`${API}/v1/auth/login`, {
      headers: { 'x-client': 'web' },
      data: { email: owner.email, password: PASSWORD },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const invitee = uniqueEmail('accountant');
    const invite = await request.post(`${API}/v1/members/invitations`, {
      headers: { authorization: `Bearer ${accessToken}` },
      data: { email: invitee, role: 'ACCOUNTANT' },
    });
    expect(invite.status(), await invite.text()).toBe(201);

    // The owner has a product the accountant will look at.
    await signInToApp(page, owner.email);
    await page.goto('/products/new');
    await page.getByLabel('Product name').fill('Ledger tee');
    await page.getByLabel('SKU').fill('LED-1');
    await page.getByLabel('Price (৳)').fill('100');
    await page.getByRole('button', { name: 'Create product' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Ledger tee' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Receive', exact: true })).toBeVisible();

    // The accountant joins through the emailed link, in a separate browser session.
    const context = await browser.newContext();
    const guest = await context.newPage();
    await guest.goto(await mailLink(invitee, 'accept-invitation'));
    await guest.getByLabel('Your name (new accounts only)').fill('Anwar Hossain');
    await guest.getByLabel('Password').fill(PASSWORD);
    await guest.getByRole('button', { name: 'Join workspace' }).click();
    await expect(guest).toHaveURL(/\/products$/);
    await expect(guest.getByTestId('tenant-name')).toHaveText(owner.shop);

    await expect(guest.getByRole('link', { name: 'Ledger tee' })).toBeVisible();
    await expect(guest.getByRole('link', { name: 'New product' })).toHaveCount(0);
    await expect(guest.getByRole('link', { name: 'Import', exact: true })).toHaveCount(0);
    await guest.getByRole('link', { name: 'Ledger tee' }).click();
    await expect(guest.getByRole('heading', { level: 1, name: 'Ledger tee' })).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Receive', exact: true })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);

    await guest.goto('/products/new');
    await expect(
      guest.getByText('Your role can view the catalog but not change it.'),
    ).toBeVisible();
    await context.close();
  });
});
