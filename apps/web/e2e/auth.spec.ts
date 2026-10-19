import {
  API,
  createAccount,
  expect,
  expectAccessible,
  expectNoHorizontalOverflow,
  mailLink,
  PASSWORD,
  signIn,
  signInToApp,
  test,
  uniqueEmail,
} from './fixtures';
import { expectSignedInAs, signOutViaMenu } from './support/ui';

test.describe('signing up, in and out', () => {
  test('a new owner signs up, verifies the email from the real message, signs out and back in', async ({
    page,
  }) => {
    const email = uniqueEmail('signup');
    await page.goto('/signup');
    await page.getByLabel('Your name').fill('Rina Akter');
    await page.getByLabel('Business name').fill('Rina Fashion');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('tenant-name')).toHaveText('Rina Fashion');
    await expect(page.getByText('Please verify your email address')).toBeVisible();

    // The link from the email works once, and the banner goes away.
    await page.goto(await mailLink(email, 'verify-email'));
    await expect(page.getByText('Your email address is verified')).toBeVisible();
    await page.getByRole('link', { name: 'Continue to OrderLoop' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), / }),
    ).toBeVisible();
    await expect(page.getByText('Please verify your email address')).toHaveCount(0);

    await signOutViaMenu(page);
    await expect(page).toHaveURL(/\/login$/);
    await signInToApp(page, email);
  });

  test('a wrong password is explained and nobody is signed in', async ({ page, request }) => {
    const { email } = await createAccount(request);
    await signIn(page, email, 'not-the-password-1');
    await expect(page.getByText('Incorrect email or password.')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('sign-up says exactly what is missing, then what is too weak', async ({ page }) => {
    await page.goto('/signup');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Name is required', { exact: true })).toBeVisible();
    await expect(page.getByText('Business name is required')).toBeVisible();
    await expect(page.getByText('Email is required')).toBeVisible();
    await expect(page.getByText('Password is required')).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');

    // The messages follow the rules as the person types.
    await page.getByLabel('Your name').fill('Al');
    await page.getByLabel('Business name').fill('Ab');
    await page.getByLabel('Email').fill('not-an-email');
    await expect(
      page.getByText('Name must be at least 3 characters', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Business name must be at least 3 characters')).toBeVisible();
    await expect(page.getByText('Enter a valid email address')).toBeVisible();

    const password = page.getByLabel('Password');
    for (const [typed, message] of [
      ['Ab1!', 'Password must be at least 8 characters'],
      ['abcdefg1!', 'Password must include an uppercase letter'],
      ['Abcdefgh!', 'Password must include a number'],
      ['Abcdefg12', 'Password must include a special character'],
    ] as const) {
      await password.fill(typed);
      await expect(page.getByText(message)).toBeVisible();
    }

    await page.getByLabel('Your name').fill('Alice');
    await page.getByLabel('Business name').fill('Alice Store');
    await page.getByLabel('Email').fill(uniqueEmail('rules'));
    await password.fill('Abcdef1!');
    await expect(page.locator('form [role=alert]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('sign-in asks for both fields without revealing the password rule', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Email is required')).toBeVisible();
    await expect(page.getByText('Password is required')).toBeVisible();
  });

  test('a private page sends a visitor to sign in and brings them back afterwards', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request);
    await page.goto('/inventory');
    await expect(page).toHaveURL(/\/login\?next=%2Finventory$/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/inventory$/);
  });

  test('the post-login destination cannot be an outside site', async ({ page, request }) => {
    const { email } = await createAccount(request);
    await page.goto('/login?next=//evil.example/steal');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('the Enter key submits the sign-in form', async ({ page, request }) => {
    const { email } = await createAccount(request);
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByLabel('Password').press('Enter');
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe('password reset', () => {
  test('a reset link sets a new password, once, and the old one stops working', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request);
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('If an account exists for that address')).toBeVisible();

    const link = await mailLink(email, 'reset-password');
    await page.goto(link);
    await page.getByLabel(/^New password/).fill('A-brand-new-pass-2027');
    await page.getByLabel('Confirm new password').fill('A-brand-new-pass-2027');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Your password has been changed')).toBeVisible();

    await signIn(page, email, PASSWORD);
    await expect(page.getByText('Incorrect email or password.')).toBeVisible();
    await signIn(page, email, 'A-brand-new-pass-2027');
    await expect(page).toHaveURL(/\/dashboard$/);

    // Reusing the same link fails clearly.
    await page.goto(link);
    await page.getByLabel(/^New password/).fill('Yet-another-pass-2028');
    await page.getByLabel('Confirm new password').fill('Yet-another-pass-2028');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('This link is invalid or has expired')).toBeVisible();
  });

  test('mismatched passwords are caught before anything is sent', async ({ page }) => {
    await page.goto('/reset-password?token=anything');
    await page.getByLabel(/^New password/).fill('A-brand-new-pass-2027');
    await page.getByLabel('Confirm new password').fill('different-pass-2027');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('The passwords do not match')).toBeVisible();
  });

  test('a link without its token explains what to do', async ({ page }) => {
    await page.goto('/reset-password');
    await expect(page.getByText('This reset link is incomplete')).toBeVisible();
    await page.goto('/verify-email');
    await expect(page.getByText('This verification link is incomplete')).toBeVisible();
    await page.goto('/accept-invitation');
    await expect(page.getByText('This invitation link is incomplete')).toBeVisible();
  });
});

test.describe('the session', () => {
  test('a reload keeps the user signed in', async ({ page, request }) => {
    const { email } = await createAccount(request);
    await signInToApp(page, email);
    await page.reload();
    await expectSignedInAs(page, email);
  });

  test('two tabs reloading at once both stay signed in (refresh tokens are single use)', async ({
    page,
    request,
    context,
  }) => {
    const { email } = await createAccount(request);
    await signInToApp(page, email);
    const other = await context.newPage();
    await other.goto('/products');
    await expectSignedInAs(other, email);
    // Both tabs restore their session from the same refresh cookie at the same moment, several times in a row.
    for (let i = 0; i < 3; i++) {
      await Promise.all([page.reload(), other.reload()]);
      await expectSignedInAs(page, email);
      await expectSignedInAs(other, email);
    }
  });

  test('signing out in one tab signs out the other', async ({ page, request, context }) => {
    const { email } = await createAccount(request);
    await signInToApp(page, email);
    const other = await context.newPage();
    await other.goto('/products');
    await expectSignedInAs(other, email);
    await signOutViaMenu(page);
    await expect(other).toHaveURL(/\/login/);
  });

  test('the API really revoked the session on sign-out', async ({ page, request }) => {
    const { email } = await createAccount(request);
    await signInToApp(page, email);
    await signOutViaMenu(page);
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/products');
    await expect(page).toHaveURL(/\/login\?next=/);
    // Nothing in storage holds a token.
    const stored = await page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    );
    expect(stored).not.toMatch(/eyJ/);
    expect((await request.get(`${API}/health/live`)).ok()).toBe(true);
  });
});

test.describe('accessibility and layout of the signed-out screens', () => {
  for (const path of [
    '/login',
    '/signup',
    '/forgot-password',
    '/reset-password?token=x',
    '/verify-email',
    '/accept-invitation?token=x',
  ]) {
    test(`${path} has no WCAG A/AA violations and fits a phone`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectAccessible(page);
      await page.setViewportSize({ width: 375, height: 700 });
      await expectNoHorizontalOverflow(page);
    });
  }

  test('the labels are connected to the inputs and errors are announced', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const email = page.getByLabel('Email');
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await expect(email).toHaveAttribute('aria-describedby', /.+/);
    await expect(page.getByRole('alert').first()).toBeVisible();
  });
});
