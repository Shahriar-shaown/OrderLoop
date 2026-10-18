import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAccount, signInToApp, test } from './fixtures';
import { seedBusiness } from './support/seed';

/**
 * A tool, not a test: takes screenshots of the screens at desktop, tablet and phone widths so they can be compared with the
 * design. Run with SHOTS_DIR=/some/dir (and optionally SHOTS_PAGES=/orders,/cod) — otherwise it does nothing.
 */
const DIR = process.env.SHOTS_DIR;
const PAGES = (
  process.env.SHOTS_PAGES ??
  '/dashboard,/orders,/orders/new,/products,/couriers,/cod,/analytics,/customers,/team,/settings'
).split(',');
const SIZES = (process.env.SHOTS_SIZES ?? 'desktop,tablet,mobile').split(',');
const WIDTHS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
} as const;

test.describe('screenshots', () => {
  test.skip(!DIR, 'set SHOTS_DIR to take screenshots');
  test('every screen at three widths', async ({ page, request }) => {
    test.setTimeout(300_000);
    mkdirSync(DIR!, { recursive: true });
    const { account, orders } = await seedBusiness(request);
    await signInToApp(page, account.email);
    for (const size of SIZES as (keyof typeof WIDTHS)[]) {
      await page.setViewportSize(WIDTHS[size]);
      for (const path of PAGES) {
        const real = path.replace('{order}', orders[0]!.id);
        await page.goto(real);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);
        await page.screenshot({
          path: join(DIR!, `${size}${path.replace(/[^a-z0-9]+/gi, '_')}.png`),
          fullPage: true,
        });
      }
    }
    void createAccount;
  });
});
