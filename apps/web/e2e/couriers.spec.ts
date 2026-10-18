import type { APIRequestContext, Page } from '@playwright/test';
import {
  API,
  createAccount,
  expect,
  expectAccessible,
  expectNoHorizontalOverflow,
  PASSWORD,
  signInToApp,
  test,
} from './fixtures';

/** Put one product on the shelf through the API, and return a way to ask the API what it holds. */
async function stockUp(request: APIRequestContext, email: string) {
  const login = await request.post(`${API}/v1/auth/login`, {
    headers: { 'x-client': 'web' },
    data: { email, password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  const p = await request.post(`${API}/v1/products`, {
    headers,
    data: { name: 'Cotton tee', variants: [{ sku: 'TEE-9', priceMinor: 100_000 }] },
  });
  const variantId = ((await p.json()) as { variants: { id: string }[] }).variants[0]!.id;
  expect(
    (
      await request.post(`${API}/v1/inventory/receive`, {
        headers,
        data: { variantId, quantity: 10 },
      })
    ).status(),
  ).toBe(201);
  return {
    shipments: async (): Promise<{ status: string }[]> => {
      const orders = (await (await request.get(`${API}/v1/orders`, { headers })).json()) as {
        items: { id: string }[];
      };
      const id = orders.items[0]!.id;
      return (await (
        await request.get(`${API}/v1/orders/${id}/shipments`, { headers })
      ).json()) as {
        status: string;
      }[];
    },
  };
}

/** Take an order through the UI until it is ready to ship. */
async function readyToShip(page: Page) {
  await page.goto('/orders/new');
  await page.getByLabel(/^Phone/).fill('01712-345678');
  await page.getByLabel('Customer name').fill('Rina Akter');
  await page.getByLabel('Recipient name').fill('Rina Akter');
  await page.getByLabel(/^Address/).fill('House 5, Road 3');
  await page.getByLabel('Thana / upazila').fill('Dhanmondi');
  await page.getByLabel('District').fill('Dhaka');
  await page.getByLabel('Add an item').fill('tee');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await page.getByRole('button', { name: 'Create order', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Order #1001/ })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await expect(page.getByText('Stock is reserved for this order')).toBeVisible();
  await page.getByRole('button', { name: 'Mark ready to ship' }).click();
  await expect(page.getByText('Ready to ship').first()).toBeVisible();
  return page.url();
}

const onHand = async (page: Page) => {
  await page.goto('/inventory');
  const row = page.getByRole('row', { name: /TEE-9/i });
  await expect(row).toBeVisible();
  return (await row.getByRole('cell').nth(2).textContent())?.trim();
};

test.describe('couriers', () => {
  test('book a test order with the simulated courier, follow it to delivery, and retry safely', async ({
    page,
    request,
    tolerate,
  }) => {
    tolerate(/ERR_FAILED/); // the lost answer is deliberate
    const { email } = await createAccount(request, 'courier');
    const api = await stockUp(request, email);
    await signInToApp(page, email);
    const orderUrl = await readyToShip(page);

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
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();

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
    await expect(page.getByText('SIMULATED · not a real parcel')).toBeVisible();
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
    await expect(page.getByRole('heading', { level: 1, name: /Order #1001/ })).toBeVisible();
    await expect(page.getByText('Simulated courier update: simulated:delivered')).toBeVisible();
    // the unit left the shelf when it was picked up
    expect(await onHand(page)).toBe('9');
  });

  test('a booking the courier never confirmed blocks a second parcel until a person settles it', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'courier-unsure');
    const api = await stockUp(request, email);
    await signInToApp(page, email);
    await page.goto('/settings/couriers');
    await page.getByLabel('How should the simulated courier behave?').selectOption('unavailable');
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();

    const orderUrl = await readyToShip(page);
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
    await page.goto('/settings/couriers');
    await page.getByLabel('How should the simulated courier behave?').selectOption('success');
    await page.getByRole('button', { name: 'Save Simulated courier' }).click();
    await page.goto(orderUrl);
    await page.getByRole('button', { name: 'Book simulated parcel' }).click();
    await expect(page.getByText('Booked', { exact: true }).first()).toBeVisible();
    expect((await api.shipments()).map((s) => s.status)).toEqual(['booked', 'booking_failed']);
  });
});
