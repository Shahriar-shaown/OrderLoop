import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { API, expect, PASSWORD } from '../fixtures';

/** The heading of an order page: "#1001". */
export const orderHeading = (page: Page, number: number) =>
  page.getByRole('heading', { level: 1, name: `#${number}` });

/** The search box of a list screen (the shell's own search is a different control, so the name must match exactly). */
export const listSearch = (page: Page) =>
  page.getByRole('searchbox', { name: 'Search', exact: true });

/** Open a filter chip ("Source: All") and choose one of its options. */
export async function chooseFilter(page: Page, chip: string | RegExp, option: string) {
  await page.getByRole('button', { name: chip }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Order status chips are tabs named "<status> <count>". */
export const statusChip = (page: Page, status: string): Locator =>
  page.getByRole('tab', { name: new RegExp(`^${status}( \\d+)?$`) });

/** The page header's "N orders · M selected" line. */
export const ordersSummary = (page: Page, text: string) => page.getByText(text, { exact: true });

/**
 * Fill the Create order form with a new customer, an address and one catalog item. Leaves the form ready for "Save as draft"
 * or "Confirm order".
 */
export async function fillNewOrderForm(
  page: Page,
  o: {
    phone: string;
    name: string;
    sku: string;
    search: string;
    qty?: string;
    line1?: string;
    area?: string;
    district?: string;
  },
) {
  await page.goto('/orders/new');
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByLabel(/^Phone/).fill(o.phone);
  await page.getByLabel('Customer name').fill(o.name);
  await page.getByLabel('Recipient name').fill(o.name);
  await page.getByLabel(/^Address/).fill(o.line1 ?? 'House 5, Road 3');
  await page.getByLabel('Thana / upazila').fill(o.area ?? 'Dhanmondi');
  await page.getByLabel('District').fill(o.district ?? 'Dhaka');
  await page.getByRole('searchbox', { name: 'Add an item' }).fill(o.search);
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  if (o.qty) await page.getByLabel(`Quantity (${o.sku})`, { exact: true }).fill(o.qty);
}

/** The signed-in API headers of an account created in a test, for reading what the screens cannot show cheaply. */
export async function apiSession(request: APIRequestContext, email: string) {
  const login = await request.post(`${API}/v1/auth/login`, {
    headers: { 'x-client': 'web' },
    data: { email, password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  return { authorization: `Bearer ${accessToken}` };
}

/** Stock totals of one SKU, read from the API. */
export async function stockOfSku(
  request: APIRequestContext,
  headers: { authorization: string },
  sku: string,
) {
  const res = await request.get(`${API}/v1/products`, { headers, params: { q: sku, limit: '10' } });
  expect(res.status(), await res.text()).toBe(200);
  const { items } = (await res.json()) as {
    items: {
      variants: {
        sku: string;
        stock: { onHand: number; reserved: number; available: number };
      }[];
    }[];
  };
  const variant = items
    .flatMap((p) => p.variants)
    .find((v) => v.sku.toLowerCase() === sku.toLowerCase());
  expect(variant, `${sku} should exist`).toBeTruthy();
  return variant!.stock;
}

/** Wait until a SKU's stock matches (the order screens update it a moment after the page shows the result). */
export async function expectStockOfSku(
  request: APIRequestContext,
  headers: { authorization: string },
  sku: string,
  expected: Partial<{ onHand: number; reserved: number; available: number }>,
) {
  await expect
    .poll(async () => {
      const s = await stockOfSku(request, headers, sku);
      return Object.fromEntries(Object.keys(expected).map((k) => [k, s[k as keyof typeof s]]));
    })
    .toEqual(expected);
}

// ---- the shell: account and business menus ---------------------------------------------------------------------------

/** Open the account menu (the avatar). */
export async function openAccountMenu(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
}

/** The signed-in person's email is shown inside the account menu: open it, read it, close it. */
export async function expectSignedInAs(page: Page, email: string) {
  await openAccountMenu(page);
  await expect(page.getByTestId('user-email')).toHaveText(email);
  await page.keyboard.press('Escape');
}

/** Sign out through the account menu and wait for the sign-in page. */
export async function signOutViaMenu(page: Page) {
  await openAccountMenu(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Open the business switcher in the header. */
export async function openBusinessMenu(page: Page) {
  await page.getByRole('button', { name: /Switch business/ }).click();
}

// ---- API helpers for the courier and finance specs -------------------------------------------------------------------

/** A tiny client for an account created in a test: sign in once, then post and get against the API. */
export async function apiClient(request: APIRequestContext, email: string) {
  const headers = await apiSession(request, email);
  return {
    headers,
    async post(path: string, data: object = {}) {
      const res = await request.post(`${API}${path}`, { headers, data });
      expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
      return res.json();
    },
    async get(path: string) {
      const res = await request.get(`${API}${path}`, { headers });
      expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
      return res.json();
    },
  };
}

/** An order that is ready to ship (stock reserved), made through the API. `shipments()` lists its parcels' statuses. */
export async function seedReadyToShipOrder(request: APIRequestContext, email: string) {
  const api = await apiClient(request, email);
  const sku = `TEE-${Date.now().toString(36)}`;
  const product = await api.post('/v1/products', {
    name: 'Cotton tee',
    variants: [{ sku, priceMinor: 100_000 }],
  });
  const variantId = product.variants[0].id as string;
  await api.post('/v1/inventory/receive', { variantId, quantity: 10 });
  const order = await api.post('/v1/orders', {
    customer: { name: 'Rina Akter', phone: '01712345678' },
    address: {
      recipientName: 'Rina Akter',
      phone: '01712345678',
      line1: 'House 5, Road 3',
      area: 'Dhanmondi',
      district: 'Dhaka',
      division: 'Dhaka',
    },
    items: [{ variantId, quantity: 1 }],
    deliveryChargeMinor: 6_000,
    idempotencyKey: `seed-${Math.random().toString(36).slice(2, 12)}`,
    confirm: true,
  });
  await api.post(`/v1/orders/${order.id}/status`, { status: 'ready_to_ship' });
  return {
    sku,
    orderUrl: `/orders/${order.id}`,
    async shipments(): Promise<{ status: string }[]> {
      return api.get(`/v1/orders/${order.id}/shipments`);
    },
  };
}
