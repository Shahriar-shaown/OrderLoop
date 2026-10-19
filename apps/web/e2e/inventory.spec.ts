import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { createAccount, expect, signInToApp, test } from './fixtures';
import {
  catalogCreateProduct,
  catalogOpenMoreMenu,
  catalogOpenStockDialog,
  catalogStockAction,
  expectCatalogVariantCell as expectCell,
} from './support/catalog-ui';

const newProduct = (page: Page, name: string, sku: string) =>
  catalogCreateProduct(page, { name, sku, price: '500' });

test.describe('inventory module', () => {
  test.beforeEach(async ({ page, request }) => {
    const { email } = await createAccount(request, 'inv');
    await signInToApp(page, email);
  });

  test('a supplier, pictures, size and colour are saved on a product', async ({ page }) => {
    await page.goto('/products');
    await catalogOpenMoreMenu(page, 'Suppliers');
    await expect(page.getByText('No suppliers yet')).toBeVisible();
    await page.getByRole('button', { name: 'New supplier' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Supplier name').fill('Dhaka Weavers');
    await dialog.getByLabel('Phone').fill('not a phone');
    await dialog.getByRole('button', { name: 'Add supplier' }).click();
    await expect(dialog.getByText('Enter a valid phone number')).toBeVisible();
    await dialog.getByLabel('Phone').fill('+880 1711-000000');
    await dialog.getByRole('button', { name: 'Add supplier' }).click();
    await expect(page.getByRole('cell', { name: /Dhaka Weavers/ })).toBeVisible();

    await page.goto('/products/new');
    await page.getByLabel('Product name').fill('Handloom panjabi');
    await page.getByLabel('Description').fill('Eid collection');
    await page.getByLabel('Supplier').selectOption({ label: 'Dhaka Weavers' });
    await page.getByLabel('Picture links').fill('http://insecure.test/a.jpg');
    await page.getByLabel('SKU').fill('pan-r-m');
    await page.getByLabel('Size').fill('M');
    await page.getByLabel('Colour', { exact: true }).fill('Red');
    await page.getByLabel('Price (৳)').fill('1850');
    await page.getByLabel('Cost (৳)').fill('1100.50');
    await page.getByLabel('Reorder at').fill('3');
    await page.getByRole('button', { name: 'Create product' }).click();
    await expect(page.getByText('Picture links must start with https://')).toBeVisible();
    await page.getByLabel('Picture links').fill('https://cdn.example.test/panjabi.jpg');
    await page.getByRole('button', { name: 'Create product' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Handloom panjabi' })).toBeVisible();
    await expect(page.getByText('Dhaka Weavers')).toBeVisible();
    await expect(page.getByText('Red / M')).toBeVisible(); // the variant named itself from size and colour
    await expect(page.getByRole('img', { name: /picture 1/ })).toBeVisible();
  });

  test('damaged stock leaves the sellable count, needs a reason, and can be written off', async ({
    page,
  }) => {
    await newProduct(page, 'Glass vase', 'VASE-1');
    await catalogStockAction(page, 'VASE-1', 'Receive', { Quantity: '10' });
    await expectCell(page, 'VASE-1', 'On hand', '10');

    // a reason is required
    const dialog = await catalogOpenStockDialog(page, 'VASE-1', 'Damaged');
    await dialog.getByLabel('Quantity').fill('3');
    await dialog.getByRole('button', { name: 'Mark as damaged' }).click();
    await expect(dialog.getByText('Say why (at least 3 characters)')).toBeVisible();
    await dialog.getByLabel('Reason').fill('Cracked in transit');
    await dialog.getByRole('button', { name: 'Mark as damaged' }).click();
    await expect(dialog).toBeHidden();
    await expectCell(page, 'VASE-1', 'On hand', '7');
    await expectCell(page, 'VASE-1', 'Available', '7');
    await expectCell(page, 'VASE-1', 'Damaged', '3');

    // cannot write off more than is damaged
    await catalogStockAction(page, 'VASE-1', 'Write off', { Quantity: '5', Reason: 'Thrown away' });
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Only 3 damaged');
    await page.getByRole('dialog').getByLabel('Quantity').fill('3');
    await page.getByRole('dialog').getByRole('button', { name: 'Write off damaged' }).click();
    await expectCell(page, 'VASE-1', 'Damaged', '0');

    // the ledger explains each step
    await page.goto('/inventory');
    await page.getByRole('tab', { name: /Stock movements/ }).click();
    await expect(page.getByRole('cell', { name: 'Cracked in transit' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Damaged', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Written off', exact: true })).toBeVisible();
  });

  test('a returned item goes back on the shelf or to the damaged bucket', async ({ page }) => {
    await newProduct(page, 'Scarf', 'SCARF-1');
    await catalogStockAction(page, 'SCARF-1', 'Return', {
      Quantity: '2',
      Condition: 'Resaleable: goes back on the shelf',
      Reference: 'RET-77',
    });
    await expectCell(page, 'SCARF-1', 'On hand', '2');
    await catalogStockAction(page, 'SCARF-1', 'Return', {
      Quantity: '1',
      Condition: 'Damaged: goes to the damaged bucket',
    });
    await expectCell(page, 'SCARF-1', 'On hand', '2');
    await expectCell(page, 'SCARF-1', 'Damaged', '1');
  });

  test('low stock appears once damage takes available stock under the threshold', async ({
    page,
  }) => {
    await page.goto('/products/new');
    await page.getByLabel('Product name').fill('Candle');
    await page.getByLabel('SKU').fill('CANDLE-1');
    await page.getByLabel('Price (৳)').fill('120');
    await page.getByLabel('Reorder at').fill('5');
    await page.getByRole('button', { name: 'Create product' }).click();
    await catalogStockAction(page, 'CANDLE-1', 'Receive', { Quantity: '8' });
    await expectCell(page, 'CANDLE-1', 'Available', '8');
    await catalogStockAction(page, 'CANDLE-1', 'Damaged', {
      Quantity: '4',
      Reason: 'Melted in the heat',
    });
    await expectCell(page, 'CANDLE-1', 'Available', '4');
    await expect(page.getByRole('row', { name: /CANDLE-1/ })).toContainText('Low stock');
    await page.goto('/inventory');
    await page.getByRole('tab', { name: /Low stock/ }).click();
    await expect(page.getByRole('cell', { name: /CANDLE-1/ })).toBeVisible();
  });

  test('an import is checked first, problems are shown, and only then are good rows applied', async ({
    page,
  }) => {
    await page.goto('/imports');
    const csv =
      'product_name,sku,price,size,colour,supplier\n' +
      'Kurta,KUR-R-M,1500.50,M,Red,Dhaka Weavers\n' +
      'Kurta,KUR-B-L,not-a-price,L,Blue,Dhaka Weavers\n' +
      'Kurta,KUR-G-S,1400,S,Green,Dhaka Weavers\n';
    await page.getByLabel('CSV').fill(csv);
    await page.getByRole('button', { name: 'Check file' }).click();
    await expect(page.getByText('Nothing has been changed yet.')).toBeVisible();
    await expect(page.getByText('2 to create')).toBeVisible();
    await expect(page.getByText('1 with problems')).toBeVisible();
    await expect(
      page
        .getByRole('table', { name: 'Rows with problems' })
        .getByRole('row', { name: /3.*price must be a non-negative amount/ }),
    ).toBeVisible();

    // nothing exists yet
    await page.goto('/products');
    await expect(page.getByText('No products yet')).toBeVisible();
    await page.goBack();
    await page.getByLabel('CSV').fill(csv);
    await page.getByRole('button', { name: 'Check file' }).click();

    // editing the text discards the check: the import button disappears until checked again
    await page.getByRole('button', { name: /Import 2 fine rows, skip 1/ }).waitFor();
    await page.getByLabel('CSV').fill(csv + '\n');
    await expect(page.getByRole('button', { name: /Import 2 fine rows/ })).toHaveCount(0);
    await page.getByLabel('CSV').fill(csv);
    await page.getByRole('button', { name: 'Check file' }).click();
    await page.getByRole('button', { name: /Import 2 fine rows, skip 1/ }).click();
    await expect(page.getByText(/2 created, 0 updated, 1 failed/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.goto('/products');
    await expect(page.getByRole('link', { name: 'Kurta' })).toBeVisible();
  });

  test('the catalog and stock download as CSV files', async ({ page }) => {
    await newProduct(page, 'Export tee', 'EXP-1');
    await catalogStockAction(page, 'EXP-1', 'Receive', { Quantity: '4' });
    await expectCell(page, 'EXP-1', 'On hand', '4');

    await page.goto('/imports');
    const catalog = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export catalog CSV' }).click();
    const catalogFile = await catalog;
    expect(catalogFile.suggestedFilename()).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
    const catalogText = await readFile((await catalogFile.path())!, 'utf8');
    expect(catalogText).toContain('product_name,sku,price');
    expect(catalogText).toContain('Export tee,EXP-1,500.00');

    await page.goto('/products');
    const stock = page.waitForEvent('download');
    await catalogOpenMoreMenu(page, 'Export stock CSV');
    const stockText = await readFile((await (await stock).path())!, 'utf8');
    expect(stockText).toContain('sku,product_name,variant_name,location,on_hand,reserved,damaged');
    expect(stockText).toContain('EXP-1,Export tee,,Main warehouse,4,0,0,4,0');
  });
});
