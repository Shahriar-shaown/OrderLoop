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

test.describe('business workspaces', () => {
  test('an owner edits the business profile and it is remembered', async ({ page, request }) => {
    const owner = await createAccount(request, 'settings');
    await signInToApp(page, owner.email);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Business settings' })).toBeVisible();
    // The defaults for a Bangladesh business.
    await expect(page.getByLabel('Currency')).toHaveValue('BDT');
    await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Dhaka');
    await expectAccessible(page);

    await page.getByLabel('Business name').fill('Rina Fashion House');
    await page.getByLabel('Contact phone').fill('+880 1712-345678');
    await page.getByLabel('City').fill('Dhaka');
    await page.getByLabel('Business language').selectOption('bn');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Business settings saved')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Business name')).toHaveValue('Rina Fashion House');
    await expect(page.getByLabel('City')).toHaveValue('Dhaka');
    await expect(page.getByLabel('Business language')).toHaveValue('bn');
  });

  test('settings show the same clear messages as the API', async ({ page, request }) => {
    const owner = await createAccount(request, 'invalid');
    await signInToApp(page, owner.email);
    await page.goto('/settings');
    await page.getByLabel('Business name').fill('ab');
    await page.getByLabel('Contact email').fill('not-an-email');
    await page.getByLabel('Logo link').fill('http://insecure.test/logo.png');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Business name must be at least 3 characters')).toBeVisible();
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await expect(page.getByText('Logo link must start with https://')).toBeVisible();
  });

  test('creating a second business and switching keeps their data apart', async ({
    page,
    request,
  }) => {
    const owner = await createAccount(request, 'multi');
    await signInToApp(page, owner.email);
    await page.goto('/products/new');
    await page.getByLabel('Product name').fill('First shop tee');
    await page.getByLabel('SKU').fill('FST-1');
    await page.getByLabel('Price (৳)').fill('100');
    await page.getByRole('button', { name: 'Create product' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'First shop tee' })).toBeVisible();

    await page.goto('/workspaces/new');
    await page.getByLabel('Business name').fill('Second Shop');
    await page.getByRole('button', { name: 'Create business' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByLabel('Business name')).toHaveValue('Second Shop');

    // The second business starts empty: the first one's product is not visible.
    await page.goto('/products');
    await expect(page.getByRole('link', { name: 'First shop tee' })).toHaveCount(0);

    // Now there are two businesses to choose between.
    const switcher = page.getByLabel('Business', { exact: true });
    await expect(switcher).toHaveValue(/.+/);
    await switcher.selectOption({ label: owner.shop });
    await expect(page).toHaveURL(/\/dashboard$/); // switching lands on the dashboard of the business you chose
    await page.goto('/products');
    await expect(page.getByRole('link', { name: 'First shop tee' })).toBeVisible();
  });

  test('an accountant can read settings but not change them', async ({
    page,
    request,
    browser,
  }) => {
    const owner = await createAccount(request, 'boss2');
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
    await guest.goto('/settings');
    await expect(guest.getByLabel('Business name')).toHaveValue(owner.shop);
    await expect(
      guest.getByText('Only an owner or admin can change business settings.'),
    ).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await context.close();
  });
});
