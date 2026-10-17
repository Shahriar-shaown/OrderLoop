import type { Page } from '@playwright/test';
import {
  createAccount,
  expect,
  expectAccessible,
  expectNoHorizontalOverflow,
  signInToApp,
  test,
} from './fixtures';

/** Create a one-variant product through the UI and land on its page. */
async function createProduct(
  page: Page,
  {
    name,
    sku,
    price = '1250.50',
    reorder = '',
  }: { name: string; sku: string; price?: string; reorder?: string },
) {
  await page.goto('/products/new');
  await page.getByLabel('Product name').fill(name);
  await page.getByLabel('SKU').fill(sku);
  await page.getByLabel('Price (৳)').fill(price);
  if (reorder) await page.getByLabel('Reorder at').fill(reorder);
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

const variantRow = (page: Page, sku: string) =>
  page.getByRole('row', { name: new RegExp(sku, 'i') });
// Variant table columns: SKU, Price, On hand, Reserved, Available, Actions
const cell = (page: Page, sku: string, index: number) =>
  variantRow(page, sku).getByRole('cell').nth(index);

async function stockAction(
  page: Page,
  sku: string,
  action: 'Receive' | 'Adjust' | 'Reserve',
  amount: string,
  note?: string,
) {
  await variantRow(page, sku).getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Quantity|Change in stock/).fill(amount);
  if (note) await dialog.getByLabel(/Reason|Note/).fill(note);
  await dialog.getByRole('button', { name: /(Receive|Adjust|Reserve) stock/ }).click();
}

test.describe('the catalog', () => {
  test.beforeEach(async ({ page, request }) => {
    const { email } = await createAccount(request);
    await signInToApp(page, email);
  });

  test('an empty catalog invites the first product, and a bad form is reported field by field', async ({
    page,
  }) => {
    await expect(page.getByText('No products yet')).toBeVisible();
    await page.getByRole('link', { name: 'Add your first product' }).click();
    await page.getByRole('button', { name: 'Create product' }).click();
    await expect(page.getByLabel('Product name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('SKU')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Price (৳)')).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel('Price (৳)').fill('twelve');
    await page.getByRole('button', { name: 'Create product' }).click();
    await expect(page.getByText('Enter an amount like 1250 or 1250.50')).toBeVisible();
  });

  test('creating a product shows it, with the SKU saved in capitals and the price in taka', async ({
    page,
  }) => {
    await createProduct(page, { name: 'Cotton tee', sku: 'tee-red-m' });
    await expect(page.getByText('TEE-RED-M', { exact: true })).toBeVisible();
    await expect(page.getByText('৳1,250.50')).toBeVisible();
    await page.getByRole('link', { name: 'Back to products' }).click();
    await expect(page.getByRole('link', { name: 'Cotton tee' })).toBeVisible();
  });

  test('a duplicate SKU is refused with a message', async ({ page }) => {
    await createProduct(page, { name: 'First', sku: 'DUP-1' });
    await page.goto('/products/new');
    await page.getByLabel('Product name').fill('Second');
    await page.getByLabel('SKU').fill('dup-1');
    await page.getByLabel('Price (৳)').fill('10');
    await page.getByRole('button', { name: 'Create product' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page).toHaveURL(/\/products\/new$/);
  });

  test('receiving, adjusting and reserving stock keeps the numbers right; a double press is harmless', async ({
    page,
  }) => {
    await createProduct(page, { name: 'Stock tee', sku: 'STK-1', reorder: '3' });
    await stockAction(page, 'STK-1', 'Receive', '10', 'First delivery');
    await expect(cell(page, 'STK-1', 2)).toHaveText('10');
    await expect(cell(page, 'STK-1', 4)).toHaveText('10');

    await stockAction(page, 'STK-1', 'Adjust', '-3', 'Damaged in storage');
    await expect(cell(page, 'STK-1', 2)).toHaveText('7');

    await stockAction(page, 'STK-1', 'Reserve', '2');
    await expect(cell(page, 'STK-1', 3)).toHaveText('2');
    await expect(cell(page, 'STK-1', 4)).toHaveText('5');

    // Removing more than is available is refused and changes nothing.
    await variantRow(page, 'STK-1').getByRole('button', { name: 'Adjust', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Change in stock').fill('-50');
    await dialog.getByLabel('Reason').fill('Test overdraw');
    await dialog.getByRole('button', { name: 'Adjust stock' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/Only \d+ available/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(cell(page, 'STK-1', 2)).toHaveText('7');
  });

  test('stock validation explains itself before sending anything', async ({ page }) => {
    await createProduct(page, { name: 'Check tee', sku: 'CHK-1' });
    await variantRow(page, 'CHK-1').getByRole('button', { name: 'Receive', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Quantity').fill('abc');
    await dialog.getByRole('button', { name: 'Receive stock' }).click();
    await expect(dialog.getByText('Enter a whole number')).toBeVisible();
    await dialog.getByLabel('Quantity').fill('0');
    await dialog.getByRole('button', { name: 'Receive stock' }).click();
    await expect(dialog.getByText('Enter 1 or more')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('the Stock page shows levels, low stock, movements and reservations', async ({ page }) => {
    await createProduct(page, { name: 'Level tee', sku: 'LVL-1', reorder: '10' });
    await stockAction(page, 'LVL-1', 'Receive', '4');
    await expect(cell(page, 'LVL-1', 2)).toHaveText('4');
    await stockAction(page, 'LVL-1', 'Reserve', '1');
    await expect(cell(page, 'LVL-1', 3)).toHaveText('1');

    await page.getByRole('link', { name: 'Stock', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Stock' })).toBeVisible();
    await expect(page.getByRole('row', { name: /LVL-1/ })).toContainText('Main warehouse');

    await page.getByRole('tab', { name: 'Low stock' }).click();
    await expect(page.getByRole('row', { name: /LVL-1/ })).toBeVisible();

    await page.getByRole('tab', { name: 'Movements' }).click();
    await expect(page.getByRole('row', { name: /LVL-1.*\+4/ })).toBeVisible();

    await page.getByRole('tab', { name: 'Reservations' }).click();
    await expect(page.getByRole('row', { name: /manual|—/ }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Release' }).first().click();
    await expect(page.getByText('Reservation released')).toBeVisible();
  });

  test('receiving into a second location, chosen from the Stock page', async ({ page }) => {
    await createProduct(page, { name: 'Shelf tee', sku: 'SHF-1' });
    await stockAction(page, 'SHF-1', 'Receive', '5');
    await expect(cell(page, 'SHF-1', 2)).toHaveText('5');

    await page.getByRole('link', { name: 'Locations', exact: true }).click();
    await page.getByRole('button', { name: 'New location' }).click();
    await page.getByRole('dialog').getByLabel('Location name').fill('Pop-up stall');
    await page.getByRole('dialog').getByRole('button', { name: 'Create location' }).click();
    await expect(page.getByText('Location created')).toBeVisible();
    await expect(page.getByRole('row', { name: /Pop-up stall/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Main warehouse/ })).toContainText('Default');

    await page
      .getByRole('row', { name: /Pop-up stall/ })
      .getByRole('button', { name: 'Make default' })
      .click();
    await expect(page.getByRole('row', { name: /Pop-up stall/ })).toContainText('Default');
  });

  test('categories can be created, renamed, assigned and deleted', async ({ page }) => {
    await page.getByRole('link', { name: 'Categories', exact: true }).click();
    await page.getByRole('button', { name: 'New category' }).click();
    await page.getByRole('dialog').getByLabel('Category name').fill('Shirts');
    await page.getByRole('dialog').getByRole('button', { name: 'Create category' }).click();
    await expect(page.getByRole('row', { name: /Shirts/ })).toBeVisible();

    await page
      .getByRole('row', { name: /Shirts/ })
      .getByRole('button', { name: 'Rename' })
      .click();
    await page.getByRole('dialog').getByLabel('Category name').fill('T-shirts');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('row', { name: /T-shirts/ })).toBeVisible();

    await createProduct(page, { name: 'Categorised tee', sku: 'CAT-1' });
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.getByRole('dialog').getByLabel('Category').selectOption({ label: 'T-shirts' });
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Product saved')).toBeVisible();
    await expect(page.getByText('T-shirts')).toBeVisible();

    await page.goto('/categories');
    await page
      .getByRole('row', { name: /T-shirts/ })
      .getByRole('button', { name: 'Delete' })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Deleted T-shirts')).toBeVisible();
    await expect(page.getByRole('row', { name: /T-shirts/ })).toHaveCount(0);
  });

  test('archiving hides a product from the list and restoring brings it back', async ({ page }) => {
    await createProduct(page, { name: 'Old tee', sku: 'OLD-1' });
    await page.getByRole('button', { name: 'Archive', exact: true }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText('This product is archived')).toBeVisible();
    await page.goto('/products');
    await expect(page.getByRole('link', { name: 'Old tee' })).toHaveCount(0);
    await page.getByLabel('Status').selectOption('ARCHIVED');
    await page.getByRole('link', { name: 'Old tee' }).click();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('This product is archived')).toHaveCount(0);
  });

  test('searching narrows the list', async ({ page }) => {
    await createProduct(page, { name: 'Findable hat', sku: 'HAT-9' });
    await createProduct(page, { name: 'Other scarf', sku: 'SCF-9' });
    await page.goto('/products');
    await page.getByLabel('Search').fill('hat');
    await expect(page.getByRole('link', { name: 'Findable hat' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Other scarf' })).toHaveCount(0);
    await page.getByLabel('Search').fill('zzzz-nothing');
    await expect(page.getByText('No products match')).toBeVisible();
  });

  test('a CSV import runs in the background and its products appear', async ({ page }) => {
    await page.getByRole('link', { name: 'Import', exact: true }).click();
    await page.getByRole('button', { name: 'Use the example' }).click();
    await page.getByRole('button', { name: 'Start import' }).click();
    await expect(page.getByText(/1 created, 0 updated, 0 failed/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.goto('/products');
    await expect(page.getByRole('link', { name: 'Cotton tee' })).toBeVisible();
  });
});

test.describe('accessibility and small screens of the signed-in screens', () => {
  test('every main screen passes the WCAG A/AA scan and fits a phone', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request);
    await signInToApp(page, email);
    await createProduct(page, { name: 'Scan tee', sku: 'SCAN-1', reorder: '2' });
    await stockAction(page, 'SCAN-1', 'Receive', '3');
    await expect(cell(page, 'SCAN-1', 2)).toHaveText('3');
    const detail = page.url();

    await expectAccessible(page);
    await variantRow(page, 'SCAN-1').getByRole('button', { name: 'Adjust', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press('Escape');

    for (const path of [
      '/products',
      '/products/new',
      '/inventory',
      '/categories',
      '/locations',
      '/imports',
      detail,
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectAccessible(page);
    }

    await page.setViewportSize({ width: 375, height: 800 });
    for (const path of ['/products', '/inventory', detail, '/products/new']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test('the whole sign-in to first stock flow works with the keyboard alone', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request);
    await page.goto('/login');
    await page.keyboard.press('Tab'); // skip link
    await page.keyboard.press('Tab'); // brand link
    await page.keyboard.press('Tab'); // email
    await page.keyboard.type(email);
    await page.keyboard.press('Tab');
    await page.keyboard.type('Orderloop-e2e-2026!');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/products$/);
    // The skip link is the first stop and jumps past the menu.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });
});
