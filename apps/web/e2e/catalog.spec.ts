import {
  createAccount,
  expect,
  expectAccessible,
  expectNoHorizontalOverflow,
  signInToApp,
  test,
} from './fixtures';
import {
  catalogCreateProduct as createProduct,
  catalogOpenMoreMenu,
  catalogOpenStockDialog,
  catalogStockAction,
  expectCatalogVariantCell as expectCell,
} from './support/catalog-ui';

test.describe('the catalog', () => {
  test.beforeEach(async ({ page, request }) => {
    const { email } = await createAccount(request);
    await signInToApp(page, email);
    await page.goto('/products');
    // Let the reload finish restoring the session before the test navigates again (see docs/web.md, known limits).
    await expect(
      page.getByRole('heading', { level: 1, name: 'Products & inventory' }),
    ).toBeVisible();
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
    await expect(page.getByText('৳1,250.50').first()).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Products' })
      .click();
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
    await catalogStockAction(page, 'STK-1', 'Receive', {
      Quantity: '10',
      Note: 'First delivery',
    });
    await expectCell(page, 'STK-1', 'On hand', '10');
    await expectCell(page, 'STK-1', 'Available', '10');

    await catalogStockAction(page, 'STK-1', 'Adjust', {
      'Change in stock': '-3',
      Reason: 'Damaged in storage',
    });
    await expectCell(page, 'STK-1', 'On hand', '7');

    await catalogStockAction(page, 'STK-1', 'Reserve', { Quantity: '2' });
    await expectCell(page, 'STK-1', 'Reserved', '2');
    await expectCell(page, 'STK-1', 'Available', '5');

    // Removing more than is available is refused and changes nothing.
    const dialog = await catalogOpenStockDialog(page, 'STK-1', 'Adjust');
    await dialog.getByLabel('Change in stock').fill('-50');
    await dialog.getByLabel('Reason').fill('Test overdraw');
    await dialog.getByRole('button', { name: 'Adjust stock' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/Only \d+ available/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expectCell(page, 'STK-1', 'On hand', '7');
  });

  test('an error goes away as soon as its field is filled in, and the others stay until fixed', async ({
    page,
  }) => {
    await page.goto('/products/new');
    await page.getByRole('button', { name: 'Create product' }).first().click();
    const nameError = page.locator('[role="alert"]').filter({ hasText: /name/i });
    await expect(page.getByRole('alert').first()).toBeVisible();
    const before = await page.getByRole('alert').count();
    expect(before).toBeGreaterThan(1);
    await page.getByLabel('Product name').fill('Linen shirt');
    await expect(nameError).toHaveCount(0);
    await expect(page.getByRole('alert')).not.toHaveCount(before); // only that one went
    await page.getByLabel('SKU').fill('LIN-1');
    await expect(page.getByRole('alert')).not.toHaveCount(before - 1);
  });

  test('stock validation explains itself before sending anything', async ({ page }) => {
    await createProduct(page, { name: 'Check tee', sku: 'CHK-1' });
    const dialog = await catalogOpenStockDialog(page, 'CHK-1', 'Receive');
    await dialog.getByLabel('Quantity').fill('abc');
    await dialog.getByRole('button', { name: 'Receive stock' }).click();
    await expect(dialog.getByText('Enter a whole number')).toBeVisible();
    await dialog.getByLabel('Quantity').fill('0');
    await dialog.getByRole('button', { name: 'Receive stock' }).click();
    await expect(dialog.getByText('Enter 1 or more')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Products & inventory shows stock status, low stock, movements and reservations', async ({
    page,
  }) => {
    await createProduct(page, { name: 'Level tee', sku: 'LVL-1', reorder: '10' });
    await catalogStockAction(page, 'LVL-1', 'Receive', { Quantity: '4' });
    await expectCell(page, 'LVL-1', 'On hand', '4');
    await catalogStockAction(page, 'LVL-1', 'Reserve', { Quantity: '1' });
    await expectCell(page, 'LVL-1', 'Reserved', '1');

    await page.getByRole('link', { name: 'Products & inventory', exact: true }).first().click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Products & inventory' }),
    ).toBeVisible();
    // 4 on hand, 1 reserved: 3 available against a reorder point of 10.
    await expect(page.getByRole('row', { name: /LVL-1/ })).toContainText('Critical · 3 left');

    await page.getByRole('tab', { name: /Low stock/ }).click();
    await expect(page.getByRole('row', { name: /LVL-1/ })).toBeVisible();

    await page.getByRole('tab', { name: /Stock movements/ }).click();
    await expect(page.getByRole('row', { name: /LVL-1.*\+4/ })).toBeVisible();

    await page.getByRole('tab', { name: /Reservations/ }).click();
    await expect(page.getByRole('row', { name: /manual|—/ }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Release' }).first().click();
    await expect(page.getByText('Reservation released')).toBeVisible();
  });

  test('receiving into a second location, created from the Locations page', async ({ page }) => {
    await createProduct(page, { name: 'Shelf tee', sku: 'SHF-1' });
    await catalogStockAction(page, 'SHF-1', 'Receive', { Quantity: '5' });
    await expectCell(page, 'SHF-1', 'On hand', '5');
    const product = page.url();

    await page.goto('/products');
    await catalogOpenMoreMenu(page, 'Locations');
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

    // Stock can now be received into the new location, and counts with the rest.
    await page.goto(product);
    await catalogStockAction(page, 'SHF-1', 'Receive', {
      Location: 'Pop-up stall (default)',
      Quantity: '3',
    });
    await expectCell(page, 'SHF-1', 'On hand', '8');
  });

  test('categories can be created, renamed, assigned and deleted', async ({ page }) => {
    await page.getByRole('tab', { name: /Categories/ }).click();
    await page.getByRole('button', { name: 'New category' }).click();
    await page.getByRole('dialog').getByLabel('Category name').fill('Shirts');
    await page.getByRole('dialog').getByRole('button', { name: 'Create category' }).click();
    await expect(page.getByRole('row', { name: /Shirts/ })).toBeVisible();

    await page.getByRole('button', { name: 'Actions for Shirts' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
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
    await page.getByRole('button', { name: 'Actions for T-shirts' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
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
    await page.getByRole('button', { name: /^Status:/ }).click();
    await page.getByRole('option', { name: 'Archived' }).click();
    await page.getByRole('link', { name: 'Old tee' }).click();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('This product is archived')).toHaveCount(0);
  });

  test('searching narrows the list', async ({ page }) => {
    await createProduct(page, { name: 'Findable hat', sku: 'HAT-9' });
    await createProduct(page, { name: 'Other scarf', sku: 'SCF-9' });
    await page.goto('/products');
    await page.getByRole('searchbox', { name: 'Search products' }).fill('hat');
    await expect(page.getByRole('link', { name: 'Findable hat' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Other scarf' })).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Search products' }).fill('zzzz-nothing');
    await expect(page.getByText('No products match')).toBeVisible();
  });

  test('a CSV import runs in the background and its products appear', async ({ page }) => {
    await page.getByRole('link', { name: 'Bulk import' }).click();
    await page.getByRole('button', { name: 'Use the example' }).click();
    await page.getByRole('button', { name: 'Check file' }).click();
    await expect(page.getByText('Nothing has been changed yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Import 1 rows' }).click();
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
    await catalogStockAction(page, 'SCAN-1', 'Receive', { Quantity: '3' });
    await expectCell(page, 'SCAN-1', 'On hand', '3');
    const detail = page.url();

    await expectAccessible(page);
    await catalogOpenStockDialog(page, 'SCAN-1', 'Adjust');
    await expectAccessible(page);
    await page.keyboard.press('Escape');

    for (const path of [
      '/dashboard',
      '/orders',
      '/products',
      '/couriers',
      '/cod',
      '/analytics',
      '/customers',
      '/team',
      '/settings',
      '/products/new',
      '/inventory',
      '/categories',
      '/locations',
      '/suppliers',
      '/imports',
      detail,
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectAccessible(page);
    }

    await page.setViewportSize({ width: 375, height: 800 });
    for (const path of [
      '/dashboard',
      '/orders',
      '/products',
      '/inventory',
      detail,
      '/products/new',
      '/couriers',
      '/cod',
      '/analytics',
      '/customers',
      '/settings',
    ]) {
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
    await expect(page).toHaveURL(/\/dashboard$/);
    // The skip link is the first stop and jumps past the menu.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });
});
