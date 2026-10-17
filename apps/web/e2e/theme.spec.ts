import { createAccount, expect, expectAccessible, signInToApp, test } from './fixtures';

const background = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const DARK = 'rgb(9, 9, 11)';
const LIGHT = 'rgb(255, 255, 255)';

test.describe('colour theme', () => {
  test.describe('on a light device', () => {
    test.use({ colorScheme: 'light' });

    test('Auto follows the device, Dark overrides it, and the choice survives a reload with no flash', async ({
      page,
    }) => {
      await page.goto('/login');
      expect(await background(page)).toBe(LIGHT);
      await expect(page.getByRole('radio', { name: 'Auto' })).toBeChecked();

      await page.getByRole('radio', { name: 'Dark' }).click();
      await expect.poll(() => background(page)).toBe(DARK);
      await expect(page.locator('html')).toHaveAttribute('data-scheme', 'dark');

      // The saved choice is applied before the page paints (the init script), so even the first frame is dark.
      await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          (window as unknown as { firstBackground: string }).firstBackground = getComputedStyle(
            document.body,
          ).backgroundColor;
        });
      });
      await page.reload();
      expect(
        await page.evaluate(
          () => (window as unknown as { firstBackground: string }).firstBackground,
        ),
      ).toBe(DARK);
      await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();

      await page.getByRole('radio', { name: 'Auto' }).click();
      await expect.poll(() => background(page)).toBe(LIGHT);
    });
  });

  test.describe('on a dark device', () => {
    test.use({ colorScheme: 'dark' });

    test('Light overrides the device inside the app, and both themes pass the accessibility scan', async ({
      page,
      request,
    }) => {
      const { email } = await createAccount(request);
      await signInToApp(page, email);
      expect(await background(page)).toBe(DARK);
      await expectAccessible(page);

      await page.getByRole('radio', { name: 'Light' }).click();
      await expect.poll(() => background(page)).toBe(LIGHT);
      await expectAccessible(page);

      // It stays light while moving between pages and after a reload.
      await page.getByRole('link', { name: 'Stock', exact: true }).click();
      expect(await background(page)).toBe(LIGHT);
      await page.reload();
      await expect(page.getByTestId('user-email')).toHaveText(email);
      expect(await background(page)).toBe(LIGHT);
    });
  });
});
