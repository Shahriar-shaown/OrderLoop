import type { Page } from '@playwright/test';
import {
  createAccount,
  expect,
  expectAccessible,
  expectNoHorizontalOverflow,
  signInToApp,
  test,
} from './fixtures';
import { seedBusiness } from './support/seed';
import { apiSession, expectStockOfSku, seedReadyToShipOrder } from './support/ui';

/** Open the courier's side sheet on the Couriers page ("Connect" or "Manage"). */
async function openCourier(page: Page, name: string, verb: 'Connect' | 'Manage') {
  await page.goto('/couriers');
  await page.getByRole('button', { name: `${verb} ${name}` }).click();
  const sheet = page.getByRole('dialog', { name: `${name} connection` });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The page's open sheet must be closed before the page behind it can be used. */
async function closeSheet(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.describe('couriers', () => {
  test('book a test order with the simulated courier, follow it to delivery, and retry safely', async ({
    page,
    request,
    tolerate,
  }) => {
    tolerate(/ERR_FAILED/); // the lost answer is deliberate
    const { email } = await createAccount(request, 'courier');
    const api = await seedReadyToShipOrder(request, email);
    const orderUrl = api.orderUrl;
    await signInToApp(page, email);
    await page.goto(orderUrl);

    // nothing is connected yet: the order page says so and points to the settings
    await expect(page.getByText('No courier is connected')).toBeVisible();
    await page.getByRole('link', { name: 'Go to courier settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Couriers' })).toBeVisible();
    // the simulated courier is labelled as such, and real couriers say what they need
    await expect(page.getByText('SIMULATED', { exact: true })).toBeVisible();
    await expect(page.getByText('Your courier details stay on the server')).toBeVisible();
    await expect(page.getByLabel(/^Client secret/)).toHaveAttribute('type', 'password');
    await expect(page.getByLabel(/^Secret key/)).toHaveAttribute('type', 'password');
    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);

    // turn the simulated courier on from the Couriers & shipments page
    const sheet = await openCourier(page, 'Simulated courier', 'Connect');
    await sheet.getByRole('button', { name: 'Turn on' }).click();
    await closeSheet(page);
    await expect(
      page.getByRole('group', { name: 'Simulated courier' }).getByText('Connected'),
    ).toBeVisible();

    // book: the first attempt reaches the server, but its answer is lost on the way back
    await page.goto(orderUrl);
    await expect(
      page.getByText('Simulated courier. Booking creates a pretend parcel'),
    ).toBeVisible();
    let first = true;
    await page.route('**/v1/orders/*/shipments', async (route) => {
      if (route.request().method() === 'POST' && first) {
        first = false;
        await route.fetch(); // the server books it...
        await route.abort('failed'); // ...and the answer never arrives
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'Book simulated parcel' }).click();
    await expect(page.getByText(/Pressing Book again is safe/)).toBeVisible();
    // pressing again retries the same booking: still one parcel
    await page.getByRole('button', { name: 'Book simulated parcel' }).click();
    await expect(page.getByText('SIMULATED', { exact: true })).toBeVisible();
    await expect(page.getByText('Simulated parcel ID')).toBeVisible();
    await expect(page.getByText('Booked', { exact: true }).first()).toBeVisible();
    expect((await api.shipments()).map((s) => s.status)).toEqual(['booked']);
    await expect(page.getByText('Ready to ship').first()).toBeVisible(); // booking alone moves nothing
    await expect(page.getByText(/pretend parcel|No courier knows about it/).first()).toBeVisible();
    await expectAccessible(page);

    // the simulated courier reports progress; the order follows
    await page.getByRole('button', { name: 'Picked up', exact: true }).click();
    await expect(page.getByText("Courier's words: simulated:picked_up")).toBeVisible();
    await expect(
      page.getByRole('region').getByText('Shipped').first().or(page.getByText('Shipped').first()),
    ).toBeVisible();
    await page.getByRole('button', { name: 'In transit', exact: true }).click();
    await page.getByRole('button', { name: 'Delivered', exact: true }).click();
    await expect(page.getByText("Courier's words: simulated:delivered")).toBeVisible();
    await page.goto(orderUrl);
    await expect(page.getByRole('heading', { level: 1, name: '#1001' })).toBeVisible();
    await expect(page.getByText('Simulated courier update: simulated:delivered')).toBeVisible();
    // the unit left the shelf when it was picked up
    await expectStockOfSku(request, await apiSession(request, email), api.sku, { onHand: 9 });
  });

  test('a booking the courier never confirmed blocks a second parcel until a person settles it', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'courier-unsure');
    const api = await seedReadyToShipOrder(request, email);
    const orderUrl = api.orderUrl;
    await signInToApp(page, email);
    const connect = await openCourier(page, 'Simulated courier', 'Connect');
    await connect
      .getByLabel('How should the simulated courier behave?')
      .selectOption('unavailable');
    await connect.getByRole('button', { name: 'Turn on' }).click();
    await closeSheet(page);
    await expect(
      page.getByRole('group', { name: 'Simulated courier' }).getByText('Connected'),
    ).toBeVisible();

    await page.goto(orderUrl);
    await page.getByRole('button', { name: 'Book simulated parcel' }).click();
    await expect(page.getByText('Booking not confirmed').first()).toBeVisible();
    await expect(
      page.getByText(/Booking again before that could send two parcels/).first(),
    ).toBeVisible();
    // no way to book a second one from here
    await expect(page.getByRole('button', { name: 'Book simulated parcel' })).toHaveCount(0);
    expect((await api.shipments()).map((s) => s.status)).toEqual(['booking_uncertain']);

    // look at the courier's panel, say what was there
    await page.getByRole('button', { name: 'Settle this booking' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('What did you find?').selectOption('not_booked');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText(/Say what you saw|required/i)).toBeVisible();
    await dialog.getByLabel('What did you see?').fill('Nothing under that reference');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Booking failed').first()).toBeVisible();

    // now a fresh booking is allowed (the courier is behaving again)
    const manage = await openCourier(page, 'Simulated courier', 'Manage');
    await manage.getByLabel('How should the simulated courier behave?').selectOption('success');
    await manage.getByRole('button', { name: 'Save Simulated courier' }).click();
    await expect(page.getByText('Simulated courier saved')).toBeVisible();
    await closeSheet(page);
    await page.goto(orderUrl);
    await page.getByRole('button', { name: 'Book simulated parcel' }).click();
    await expect(page.getByText('Booked', { exact: true }).first()).toBeVisible();
    expect((await api.shipments()).map((s) => s.status)).toEqual(['booked', 'booking_failed']);
  });

  test('the Couriers & shipments page shows the courier cards, the figures and a booked shipment with its detail', async ({
    page,
    request,
  }) => {
    const { account } = await seedBusiness(request, 'courier-page');
    await signInToApp(page, account.email);
    await page.goto('/couriers');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Couriers & shipments' }),
    ).toBeVisible();

    // one card per courier; RedX is not offered
    for (const name of ['Pathao', 'Steadfast', 'Simulated courier'])
      await expect(page.getByRole('group', { name })).toBeVisible();
    await expect(
      page
        .getByRole('group', { name: 'Simulated courier' })
        .getByText('SIMULATED', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'Simulated courier' }).getByText('Connected'),
    ).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'Pathao' }).getByText('Not connected'),
    ).toBeVisible();
    await expect(page.getByText('RedX')).toHaveCount(0);

    // the figures
    for (const kpi of [
      /^Booked today: \d+/,
      /^Awaiting pickup: \d+/,
      /^On the way: \d+/,
      /^Delivered \(7d\): \d+/,
      /^Returned \(7d\): \d+/,
      /^COD on the way: ৳/,
    ])
      await expect(page.getByRole('group', { name: kpi })).toBeVisible();

    // a booked simulated shipment is in the table, and opens beside it
    const table = page.getByRole('table', { name: 'Shipments' });
    const row = table.getByRole('row').filter({ hasText: 'Rahim Uddin' }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText('SIMULATED', { exact: true })).toBeVisible();
    await row.click();
    const detail = page.getByRole('complementary', { name: 'Shipment detail' });
    await expect(detail.getByText('COD to collect')).toBeVisible();
    await expect(detail.getByRole('list', { name: 'Shipment history' })).toBeVisible();
    await expect(detail.getByText('SIMULATED · not a real parcel')).toBeVisible();
    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);
  });
});
