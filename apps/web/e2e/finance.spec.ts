import {
  createAccount,
  expect,
  expectAccessible,
  expectNoHorizontalOverflow,
  signInToApp,
  test,
} from './fixtures';

const HEAD =
  'transaction_id,consignment_id,tracking_code,reference,phone,date,type,collected,delivery_charge,cod_fee,return_charge,other_deduction,net,note';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const STATEMENT = [
  HEAD,
  `,UNKNOWN-1,,,,${today},cod,700,60,7,0,0,,`,
  `,UNKNOWN-1,,,,${today},cod,700,60,7,0,0,,`,
  `,,,,,${today},adjustment,0,0,0,0,25,,Monthly account fee`,
].join('\n');

test.describe('finance', () => {
  test('import a statement, see what is unmatched and duplicated, settle each line, and only then reconcile', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'finance');
    await signInToApp(page, email);
    await page.goto('/finance/settlements');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Courier settlements' }),
    ).toBeVisible();
    await expect(page.getByText('Nothing imported yet.')).toBeVisible();
    await expectAccessible(page);

    await page.getByLabel('Statement CSV').fill(STATEMENT);
    // checking changes nothing
    await page.getByRole('button', { name: 'Check file' }).click();
    await expect(page.getByText('Check only. Nothing was recorded.')).toBeVisible();
    await expect(
      page.getByText(
        '3 line(s): 0 matched, 1 not matched, 0 need a person, 1 charge(s) with no parcel, 1 duplicate(s) not counted.',
      ),
    ).toBeVisible();
    await expect(page.getByText('Nothing imported yet.')).toBeVisible();

    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText('Imported', { exact: true })).toBeVisible();
    // the duplicate is not counted: 700.00 reported, the courier kept 67.00 + 25.00
    await expect(
      page.getByText(/Cash reported ৳700\.00 · courier kept ৳92\.00 · pays out ৳608\.00/),
    ).toBeVisible();

    // the same file again adds nothing
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(
      page.getByText('This exact file was already imported. Nothing was added.'),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Open this settlement' }).click();
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
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Mark reconciled' }).click();
    await expect(page.getByText('Reconciled', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark reconciled' })).toHaveCount(0);
  });

  test('the overview keeps sales, revenue, cash, outstanding COD, expenses and profit apart, each with its source', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'finance-overview');
    await signInToApp(page, email);
    await page.goto('/finance');
    await expect(page.getByRole('heading', { level: 1, name: 'Finance' })).toBeVisible();
    for (const group of ['Sales', 'Revenue', 'Cash', 'Outstanding COD', 'Expenses'])
      await expect(page.getByRole('heading', { level: 2, name: group })).toBeVisible();
    await expect(page.getByText('From your orders').first()).toBeVisible();
    await expect(page.getByText('From courier statements').first()).toBeVisible();
    await expect(page.getByText(/Delivered is not the same as paid/).first()).toBeVisible();
    await expect(page.getByText(/never added together/)).toBeVisible();

    // a cost entered by hand appears under its own source, and can be voided
    await page.getByRole('button', { name: 'Record a cost' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Record cost' }).click();
    await expect(dialog.getByText('Enter an amount in taka, like 450 or 450.50')).toBeVisible();
    await dialog.getByLabel(/^Amount/).fill('450.50');
    await dialog.getByLabel(/^What it was for/).fill('Packing boxes');
    await dialog.getByRole('button', { name: 'Record cost' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Packing boxes')).toBeVisible();
    await expect(page.getByText('৳450.50').first()).toBeVisible();
    await expect(page.getByText('Entered by hand').first()).toBeVisible();
    await page.getByRole('button', { name: 'Void', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Reason').fill('Entered twice');
    await page.getByRole('dialog').getByRole('button', { name: 'Void cost' }).click();
    await expect(page.getByText(/voided: Entered twice/)).toBeVisible();
    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);
  });

  test('outstanding COD and the issues page say plainly when there is nothing to chase', async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request, 'finance-empty');
    await signInToApp(page, email);
    await page.goto('/finance/outstanding');
    await expect(page.getByText(/A delivered order is not proof that cash arrived/)).toBeVisible();
    await expect(page.getByText('Nothing outstanding.')).toBeVisible();
    await expectAccessible(page);
    await page.goto('/finance/issues');
    await expect(page.getByText('No unmatched lines.')).toBeVisible();
    await expect(page.getByText('No open discrepancies.')).toBeVisible();
  });
});
