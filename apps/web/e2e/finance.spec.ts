import {
  createAccount,
  expect,
  expectAccessible,
  expectNoHorizontalOverflow,
  signInToApp,
  test,
} from './fixtures';
import { apiClient, seedReadyToShipOrder } from './support/ui';

const HEAD =
  'transaction_id,consignment_id,tracking_code,reference,phone,date,type,collected,delivery_charge,cod_fee,return_charge,other_deduction,net,note';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const STATEMENT = [
  HEAD,
  `,UNKNOWN-1,,,,${today},cod,700,60,7,0,0,,`,
  `,UNKNOWN-1,,,,${today},cod,700,60,7,0,0,,`,
  `,,,,,${today},adjustment,0,0,0,0,25,,Monthly account fee`,
].join('\n');

const openImport = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: 'Import courier statement' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Import courier statement' });
  await expect(sheet).toBeVisible();
  return sheet;
};

test.describe('COD reconciliation', () => {
  test('import a statement, see what is unmatched and duplicated, settle each line, and only then reconcile', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'finance');
    await signInToApp(page, email);
    await page.goto('/cod');
    await expect(page.getByRole('heading', { level: 1, name: 'COD reconciliation' })).toBeVisible();
    await expect(page.getByText('No statements imported yet')).toBeVisible();

    const sheet = await openImport(page);
    await sheet.getByLabel('Statement CSV').fill(STATEMENT);
    // checking changes nothing
    await sheet.getByRole('button', { name: 'Check file' }).click();
    await expect(sheet.getByText('Check only. Nothing was recorded.')).toBeVisible();
    await expect(
      sheet.getByText(
        '3 line(s): 0 matched, 1 not matched, 0 need a person, 1 charge(s) with no parcel, 1 duplicate(s) not counted.',
      ),
    ).toBeVisible();

    await sheet.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(sheet.getByText('Imported', { exact: true })).toBeVisible();
    // the duplicate is not counted: 700.00 reported, the courier kept 67.00 + 25.00
    await expect(
      sheet.getByText(/Cash reported ৳700\.00 · courier kept ৳92\.00 · pays out ৳608\.00/),
    ).toBeVisible();

    // the same file again adds nothing
    await sheet.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(
      sheet.getByText('This exact file was already imported. Nothing was added.'),
    ).toBeVisible();

    await sheet.getByRole('link', { name: 'Open this settlement' }).click();
    await expect(page).toHaveURL(/\/cod\/[0-9a-f-]+$/);
    await expect(page.getByRole('heading', { level: 1, name: /^Settlement / })).toBeVisible();
    await expect(page.getByText('Needs attention').first()).toBeVisible();
    await expect(page.getByText('This settlement cannot be reconciled yet')).toBeVisible();
    await expect(page.getByText(/1 line\(s\) are not tied to any order/)).toBeVisible();
    await expect(page.getByText('Duplicate (not counted)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark reconciled' })).toBeDisabled();
    await expectAccessible(page);

    // the unmatched line and the stray charge are set aside, each with a reason that is kept
    for (const reason of ['Not one of our parcels', 'Account fee is booked elsewhere']) {
      await page.getByRole('button', { name: 'Not ours' }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Confirm' }).click();
      await expect(dialog.getByText('Say why (at least 3 characters)')).toBeVisible();
      await dialog.getByLabel('Reason').fill(reason);
      await dialog.getByRole('button', { name: 'Confirm' }).click();
      await expect(dialog).toHaveCount(0);
    }
    await expect(page.getByText('Nothing is unmatched or in doubt')).toBeVisible();
    await page.getByRole('button', { name: 'History' }).first().click();
    await expect(
      page.getByRole('dialog').getByText(/Reason: Not one of our parcels/),
    ).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();

    await page.getByRole('button', { name: 'Mark reconciled' }).click();
    await expect(page.getByText('Reconciled', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark reconciled' })).toHaveCount(0);

    // back on the list the settlement reads Reconciled
    await page.goto('/cod');
    await expect(
      page.getByRole('table', { name: 'Settlements' }).getByText('Reconciled'),
    ).toBeVisible();
  });

  test('the page keeps reported, charges, paid out and outstanding apart, and says delivered is not paid', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'finance-figures');
    const api = await apiClient(request, email);
    await api.post('/v1/settlements/import', {
      provider: 'steadfast',
      statementRef: 'ST-E2E-1',
      csv: STATEMENT,
    });
    await signInToApp(page, email);
    await page.goto('/cod');
    await expect(page.getByRole('group', { name: 'Reported by couriers: ৳700.00' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Courier charges: ৳92.00' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Paid out: ৳608.00' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Outstanding COD: ৳0.00' })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Where the COD is' })).toBeVisible();
    await expect(page.getByText(/Delivered is not paid/)).toBeVisible();

    // the settlement is listed with its status in words, and the status chips filter it
    const table = page.getByRole('table', { name: 'Settlements' });
    const row = table.getByRole('row', { name: /ST-E2E-1/ });
    await expect(row.getByText('Needs attention')).toBeVisible();
    await expect(row.getByRole('link', { name: 'ST-E2E-1' })).toBeVisible();
    await page.getByRole('tab', { name: /^Reconciled/ }).click();
    await expect(page.getByText('No settlements match')).toBeVisible();
    await page.getByRole('tab', { name: /^All/ }).click();
    await expect(row).toBeVisible();

    // the unmatched line is waiting for a person
    await expect(page.getByRole('table', { name: 'Unmatched lines' })).toBeVisible();
    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);
  });

  test('says plainly when there is nothing to chase', async ({ page, request }) => {
    const { email } = await createAccount(request, 'finance-empty');
    await signInToApp(page, email);
    await page.goto('/cod');
    await expect(page.getByText('Nothing outstanding')).toBeVisible();
    await expect(page.getByText('No unmatched lines')).toBeVisible();
    await expect(page.getByText('No open discrepancies')).toBeVisible();
    await expect(page.getByText('No statements imported yet')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Open discrepancies: 0' })).toBeVisible();
    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('cash you collected yourself', () => {
  test('a delivered order with no courier is listed, its cash recorded once, and the entry voided from the order page', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'finance-cash');
    const seeded = await seedReadyToShipOrder(request, email);
    const id = seeded.orderUrl.split('/').pop()!;
    const api = await apiClient(request, email);
    for (const status of ['shipped', 'in_transit', 'delivered'])
      await api.post(`/v1/orders/${id}/status`, { status });

    await signInToApp(page, email);
    await page.goto('/cod');
    await expect(page.getByText('Delivered without a courier').first()).toBeVisible();
    await page.getByRole('button', { name: 'Record cash' }).first().click();
    const dialog = page.getByRole('dialog', { name: /Record cash collected: order #/ });
    await expect(dialog.getByLabel(/Amount received/)).toHaveValue('1060.00');
    // more than is due is refused in the form, before anything is sent
    await dialog.getByLabel(/Amount received/).fill('1060.01');
    await dialog.getByRole('button', { name: 'Record cash' }).click();
    await expect(dialog.getByText('That is more than the ৳1,060.00 still due')).toBeVisible();
    await dialog.getByLabel(/Amount received/).fill('1060');
    await dialog.getByLabel(/Note/).fill('Own rider');
    await dialog.getByRole('button', { name: 'Record cash' }).click();
    await expect(dialog).toBeHidden();
    // nothing left to collect: the list is gone
    await expect(page.getByText('Delivered without a courier')).toHaveCount(0);

    // the order shows the cash and who recorded how much; the Collected tile counts it
    await page.goto(seeded.orderUrl);
    await expect(page.getByRole('heading', { name: 'Cash you collected' })).toBeVisible();
    await expect(page.getByRole('group', { name: /^Collected: ৳1,060\.00/ })).toBeVisible();
    await expect(page.getByText('Own rider', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record cash collected' })).toHaveCount(0);
    await expectAccessible(page);

    // a mistake is voided with a reason, and the cash is owed again
    await page.getByRole('button', { name: 'Void', exact: true }).click();
    const voiding = page.getByRole('dialog', { name: 'Void this cash entry' });
    await voiding.getByLabel('Reason').fill('Entered on the wrong day');
    await voiding.getByRole('button', { name: 'Void entry' }).click();
    await expect(page.getByText(/voided: Entered on the wrong day/)).toBeVisible();
    await expect(page.getByRole('group', { name: /^Collected: ৳0\.00/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record cash collected' })).toBeVisible();
  });
});
