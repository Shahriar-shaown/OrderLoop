import type { Page } from '@playwright/test';
import { expect } from '../fixtures';

// Helpers for the Products & inventory screens (catalog.spec.ts, inventory.spec.ts).

/** Create a one-variant product through the UI and land on its page. */
export async function catalogCreateProduct(
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

const catalogVariantsTable = (page: Page) => page.getByRole('table', { name: 'Variants' });

/** The row of a variant (by SKU) in the product page's variants table. */
export const catalogVariantRow = (page: Page, sku: string) =>
  catalogVariantsTable(page).getByRole('row', { name: new RegExp(sku, 'i') });

/** Check one number in a variant's row, found by its column header (On hand, Reserved, Available, Damaged), not by position. */
export async function expectCatalogVariantCell(
  page: Page,
  sku: string,
  header: 'On hand' | 'Reserved' | 'Available' | 'Damaged',
  value: string,
) {
  const table = catalogVariantsTable(page);
  await expect(table.getByRole('columnheader').first()).toBeVisible();
  const heads = await table.getByRole('columnheader').allTextContents();
  const index = heads.findIndex((h) => h.trim().toLowerCase() === header.toLowerCase());
  expect(index, `a "${header}" column in ${heads.join(', ')}`).toBeGreaterThanOrEqual(0);
  // The Available cell may carry a status badge after the number ("4Low stock").
  await expect(catalogVariantRow(page, sku).getByRole('cell').nth(index)).toHaveText(
    new RegExp(`^${value}(?!\\d)`),
  );
}

export type CatalogStockAction =
  'Receive' | 'Adjust' | 'Reserve' | 'Damaged' | 'Write off' | 'Return';
const STOCK_ACTIONS: Record<CatalogStockAction, { menu: string | null; submit: string }> = {
  Receive: { menu: null, submit: 'Receive stock' },
  Adjust: { menu: null, submit: 'Adjust stock' },
  Reserve: { menu: 'Reserve stock', submit: 'Reserve stock' },
  Damaged: { menu: 'Mark as damaged', submit: 'Mark as damaged' },
  'Write off': { menu: 'Write off damaged', submit: 'Write off damaged' },
  Return: { menu: 'Record a return', submit: 'Record a return' },
};

/** Open a stock dialog from a variant's row (Receive and Adjust are buttons, the rest are in its "More actions" menu). */
export async function catalogOpenStockDialog(page: Page, sku: string, action: CatalogStockAction) {
  const row = catalogVariantRow(page, sku);
  const { menu } = STOCK_ACTIONS[action];
  if (menu === null) await row.getByRole('button', { name: action, exact: true }).click();
  else {
    await row.getByRole('button', { name: `More actions for ${sku}` }).click();
    await page.getByRole('menuitem', { name: menu }).click();
  }
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Fill the open dialog's fields by label (text boxes and selects) and press its confirm button. */
export async function catalogSubmitStockDialog(
  page: Page,
  action: CatalogStockAction,
  fields: Record<string, string>,
) {
  const dialog = page.getByRole('dialog');
  for (const [label, value] of Object.entries(fields)) {
    const field = dialog.getByLabel(label);
    if ((await field.evaluate((el) => el.tagName)) === 'SELECT')
      await field.selectOption({ label: value });
    else await field.fill(value);
  }
  await dialog.getByRole('button', { name: STOCK_ACTIONS[action].submit }).click();
}

/** Open a stock dialog on a variant, fill it and confirm. */
export async function catalogStockAction(
  page: Page,
  sku: string,
  action: CatalogStockAction,
  fields: Record<string, string>,
) {
  await catalogOpenStockDialog(page, sku, action);
  await catalogSubmitStockDialog(page, action, fields);
}

/** From /products, pick an entry of the "More actions" menu (Suppliers, Locations, Export stock CSV ...). */
export async function catalogOpenMoreMenu(page: Page, item: string) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
}
