import { ApiError } from '@orderloop/api-client';
import type { CustomerDetail, TenantDeletionStatus } from '@orderloop/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { translate } from '@orderloop/ui';
import { describe, expect, it, vi } from 'vitest';
import '../../i18n/index';
import { mount, session } from '../../../test/mount';
import { expectNamedControls } from '../../../test/a11y';
import { EraseCustomerSection } from '../../components/deletion/EraseCustomerSection';
import { DeleteBusinessSection } from '../../components/deletion/DeleteBusinessSection';
import {
  TenantDeletedScreen,
  TenantDeletionGate,
} from '../../components/deletion/TenantDeletionGate';
import { SessionManager } from '../../core/session';
import { messageFor } from '../../forms/errors';
import { CustomerDetailScreen } from '../orders/CustomerDetailScreen';
import { CustomersScreen } from '../orders/CustomersScreen';
import { AccountScreen } from './AccountScreen';

const saved = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../lib/saveFile', () => ({ saveTextFile: saved }));

const customer = (extra: Partial<CustomerDetail> = {}): CustomerDetail => ({
  id: '0197b0a0-0000-7000-8000-0000000000c1',
  name: 'Rahim Uddin',
  phone: '+8801712345678',
  email: null,
  notes: null,
  erasedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  stats: {
    ordersCount: 1,
    deliveredCount: 1,
    cancelledCount: 0,
    returnedCount: 0,
    deliveredValueMinor: 100_000,
    lastOrderAt: null,
  },
  addresses: [],
  ...extra,
});

const status = (extra: Partial<TenantDeletionStatus> = {}): TenantDeletionStatus => ({
  businessName: 'Shop',
  scheduled: false,
  requestedAt: null,
  purgeAfter: null,
  graceDays: 14,
  canCancel: false,
  ...extra,
});
const scheduled = (extra: Partial<TenantDeletionStatus> = {}) =>
  status({
    scheduled: true,
    requestedAt: '2026-10-21T10:00:00.000Z',
    purgeAfter: '2026-11-04T10:00:00.000Z',
    canCancel: true,
    ...extra,
  });

describe('erasing a customer', () => {
  it('is offered only to people who may erase (owner, admin)', async () => {
    mount(<EraseCustomerSection customer={customer()} />, {}, 'STAFF');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'Erase personal data' })).toBeNull();
  });

  it('explains what goes and what stays, and asks to type ERASE before it calls the API', async () => {
    const erase = vi.fn(async () => ({
      customerId: 'c',
      erasedAt: '2026-10-21T10:00:00.000Z',
      ordersAnonymised: 1,
    }));
    mount(<EraseCustomerSection customer={customer()} />, { customers: { erase } }, 'ADMIN');
    expect(await screen.findByText(/Order totals, statuses and dates stay/)).toBeTruthy();
    expect(screen.getByText(/Couriers and Meta keep their own copies/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Erase personal data' }));
    // the dialog's own submit button has the same name: the last one is the dialog's
    const submit = () => screen.getAllByRole('button', { name: 'Erase personal data' }).at(-1)!;
    await userEvent.click(submit());
    expect(await screen.findByText('Type ERASE exactly as shown')).toBeTruthy();
    expect(erase).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/Type ERASE to confirm/), 'erase');
    await userEvent.click(submit());
    expect(await screen.findByText('Type ERASE exactly as shown')).toBeTruthy(); // case matters
    expect(erase).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText(/Type ERASE to confirm/));
    await userEvent.type(screen.getByLabelText(/Type ERASE to confirm/), 'ERASE');
    await userEvent.type(screen.getByLabelText(/Reason/), 'Asked by phone');
    await userEvent.click(submit());
    await waitFor(() =>
      expect(erase).toHaveBeenCalledWith('0197b0a0-0000-7000-8000-0000000000c1', {
        confirm: true,
        reason: 'Asked by phone',
      }),
    );
  });

  it('says how many orders are in the way, and keeps the dialog open', async () => {
    const erase = vi.fn(async () => {
      throw new ApiError(
        'This customer has 2 order(s) in progress. Finish or cancel them first, then erase the customer.',
        409,
        'erase_blocked',
      );
    });
    mount(<EraseCustomerSection customer={customer()} />, { customers: { erase } });
    await userEvent.click(await screen.findByRole('button', { name: 'Erase personal data' }));
    await userEvent.type(screen.getByLabelText(/Type ERASE to confirm/), 'ERASE');
    await userEvent.click(screen.getAllByRole('button', { name: 'Erase personal data' }).at(-1)!);
    expect(await screen.findByText(/2 order\(s\) in progress/)).toBeTruthy();
    expect(screen.getByLabelText(/Type ERASE to confirm/)).toBeTruthy(); // still open, still typed
  });

  it('shows an erased customer as erased, with nothing left to erase', async () => {
    mount(
      <EraseCustomerSection customer={customer({ erasedAt: '2026-10-21T10:00:00.000Z' })} />,
      {},
    );
    expect(await screen.findByText('Personal data erased')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Erase personal data' })).toBeNull();
  });
});

describe('deleting your account', () => {
  const accountApi = (deleteAccount: ReturnType<typeof vi.fn>) => ({
    deleteAccount,
    tenantDeletion: { status: vi.fn(async () => status()) },
  });
  async function openDialog() {
    await userEvent.click(await screen.findByRole('button', { name: 'Delete my account' }));
  }
  const submit = () => screen.getAllByRole('button', { name: 'Delete my account' }).at(-1)!;

  it('names what is removed, what stays and the blocked case, before anything is asked', async () => {
    mount(<AccountScreen />, accountApi(vi.fn()));
    expect(await screen.findByText(/signs you out everywhere/)).toBeTruthy();
    expect(screen.getByText(/the only owner of a business that has other members/)).toBeTruthy();
    expect(screen.getByText(/deleted for good after 14 days/)).toBeTruthy();
  });

  it('needs DELETE and the password, then signs out and goes to sign-in', async () => {
    const del = vi.fn(async () => ({ deleted: true as const, businessesScheduled: [] }));
    const manager = new SessionManager({
      refresh: async () => session(),
      logout: vi.fn(async () => undefined),
    });
    const { navigation } = mount(<AccountScreen />, accountApi(del), 'OWNER', { session: manager });
    await openDialog();
    await userEvent.click(submit());
    expect(await screen.findByText('Type DELETE exactly as shown')).toBeTruthy();
    expect(screen.getByText('Enter your password')).toBeTruthy();
    expect(del).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/Type DELETE to confirm/), 'DELETE');
    await userEvent.type(screen.getByLabelText(/Your password/), 'My-password-1!');
    await userEvent.click(submit());
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith({ password: 'My-password-1!', confirm: 'DELETE' }),
    );
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/login'));
    expect(manager.getSnapshot().status).toBe('anonymous');
  });

  it('puts a wrong password on the password box (not "incorrect email"), and stays open', async () => {
    const del = vi.fn(async () => {
      throw new ApiError('Invalid email or password', 401, 'invalid_credentials');
    });
    const { navigation } = mount(<AccountScreen />, accountApi(del));
    await openDialog();
    await userEvent.type(screen.getByLabelText(/Type DELETE to confirm/), 'DELETE');
    await userEvent.type(screen.getByLabelText(/Your password/), 'wrong');
    await userEvent.click(submit());
    expect(await screen.findByText('Incorrect password.')).toBeTruthy();
    expect(screen.queryByText('Incorrect email or password.')).toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('lists the businesses that block it', async () => {
    const del = vi.fn(async () => {
      throw new ApiError(
        'You are the only owner of a business that has other members.',
        409,
        'account_delete_blocked',
        [
          { path: 'businesses', message: 'Dhaka Threads' },
          { path: 'businesses', message: 'Second Shop' },
        ],
      );
    });
    mount(<AccountScreen />, accountApi(del));
    await openDialog();
    await userEvent.type(screen.getByLabelText(/Type DELETE to confirm/), 'DELETE');
    await userEvent.type(screen.getByLabelText(/Your password/), 'My-password-1!');
    await userEvent.click(submit());
    expect(await screen.findByText('Businesses that need another owner:')).toBeTruthy();
    expect(screen.getByText('• Dhaka Threads')).toBeTruthy();
    expect(screen.getByText('• Second Shop')).toBeTruthy();
  });

  it('has a name for every control', async () => {
    mount(<AccountScreen />, accountApi(vi.fn()));
    await openDialog();
    expectNamedControls();
  });
});

describe('deleting the business', () => {
  const settingsApi = (extra: Record<string, unknown> = {}, current = status()) => ({
    tenantDeletion: {
      status: vi.fn(async () => current),
      request: vi.fn(async () => scheduled()),
      cancel: vi.fn(async () => status()),
      ...extra,
    },
    exports: {
      customers: vi.fn(),
      orders: vi.fn(),
      products: vi.fn(),
      stock: vi.fn(),
    },
  });

  it('is for owners only', async () => {
    mount(<DeleteBusinessSection />, settingsApi(), 'ADMIN');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Delete this business')).toBeNull();
  });

  it('offers the exports first, then needs the exact name and the password', async () => {
    const api = settingsApi();
    mount(<DeleteBusinessSection />, api);
    expect(await screen.findByRole('button', { name: 'Export customers CSV' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export orders CSV' })).toBeTruthy();
    expect(screen.getByText(/deleted for good after 14 days/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Delete this business' }));
    const submit = () => screen.getAllByRole('button', { name: 'Delete this business' }).at(-1)!;
    await userEvent.type(screen.getByLabelText(/Type the business name to confirm/), 'shop');
    await userEvent.type(screen.getByLabelText(/Your password/), 'My-password-1!');
    await userEvent.click(submit());
    expect(await screen.findByText('Type Shop exactly as shown')).toBeTruthy();
    expect(api.tenantDeletion.request).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText(/Type the business name to confirm/));
    await userEvent.type(screen.getByLabelText(/Type the business name to confirm/), 'Shop');
    await userEvent.click(submit());
    await waitFor(() =>
      expect(api.tenantDeletion.request).toHaveBeenCalledWith({
        confirmName: 'Shop',
        password: 'My-password-1!',
      }),
    );
  });

  it('shows a pending deletion with its date and a way to cancel it', async () => {
    const api = settingsApi({}, scheduled());
    mount(<DeleteBusinessSection />, api);
    expect(await screen.findByText('This business is scheduled for deletion')).toBeTruthy();
    expect(screen.getByText(/will be deleted for good on/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel deletion' }));
    await waitFor(() => expect(api.tenantDeletion.cancel).toHaveBeenCalled());
  });
});

describe('the screen that replaces the app while the business is scheduled for deletion', () => {
  const gateApi = (current: TenantDeletionStatus, extra: Record<string, unknown> = {}) => ({
    tenantDeletion: {
      status: vi.fn(async () => current),
      cancel: vi.fn(async () => status()),
    },
    workspaces: { list: vi.fn(async () => []) },
    ...extra,
  });

  it('shows the app when nothing is scheduled', async () => {
    mount(
      <TenantDeletionGate>
        <p>The orders page</p>
      </TenantDeletionGate>,
      gateApi(status()),
    );
    expect(await screen.findByText('The orders page')).toBeTruthy();
  });

  it('blocks the app, shows the date, and lets the owner cancel', async () => {
    const api = gateApi(scheduled());
    mount(
      <TenantDeletionGate>
        <p>The orders page</p>
      </TenantDeletionGate>,
      api,
    );
    expect(await screen.findByText(/scheduled for deletion on/)).toBeTruthy();
    expect(screen.queryByText('The orders page')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel deletion' }));
    await waitFor(() => expect(api.tenantDeletion.cancel).toHaveBeenCalled());
  });

  it('gives everyone else no cancel button, but a way to another business and to sign out', async () => {
    const switchTenant = vi.fn(async () => session('MANAGER'));
    const api = gateApi(scheduled({ canCancel: false }), {
      workspaces: {
        list: vi.fn(async () => [
          { id: 't', name: 'Shop', role: 'STAFF', joinedAt: '2026-01-01T00:00:00.000Z' },
          { id: 't2', name: 'Other Shop', role: 'MANAGER', joinedAt: '2026-01-02T00:00:00.000Z' },
        ]),
      },
      auth: { switchTenant },
    });
    const { navigation } = mount(<TenantDeletedScreen />, api, 'STAFF');
    expect(await screen.findByText(/Only an owner of the business can cancel/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel deletion' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to Other Shop' }));
    await waitFor(() => expect(switchTenant).toHaveBeenCalledWith('t2'));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
  });
});

describe('customers screens', () => {
  const rows = { items: [customer()], nextCursor: null };

  it('exports the customer list as CSV for anyone who can read orders', async () => {
    const file = { filename: 'customers-2026-10-21.csv', rowCount: 1, csv: 'name\r\nRahim\r\n' };
    const exportCustomers = vi.fn(async () => file);
    mount(
      <CustomersScreen />,
      {
        customers: { list: async () => rows },
        exports: { customers: exportCustomers },
      },
      'STAFF',
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Export customers CSV' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(file.filename, file.csv));
  });

  it('an erased customer cannot be edited, ordered for or given addresses, and says so', async () => {
    const erased = customer({
      name: 'Erased customer',
      phone: 'erased-0197b0a0',
      erasedAt: '2026-10-21T10:00:00.000Z',
    });
    mount(<CustomerDetailScreen id={erased.id} />, {
      customers: {
        get: async () => erased,
        orders: async () => ({ items: [], nextCursor: null, total: 0, statusCounts: {} }),
      },
    });
    expect(await screen.findByText('Personal data erased')).toBeTruthy();
    for (const name of ['Edit', 'Create order', 'Add address', 'Erase personal data'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Create order' })).toBeNull();
  });

  it('a customer who can be erased offers it on their page', async () => {
    mount(<CustomerDetailScreen id={customer().id} />, {
      customers: {
        get: async () => customer(),
        orders: async () => ({ items: [], nextCursor: null, total: 0, statusCounts: {} }),
      },
    });
    expect(await screen.findByRole('button', { name: 'Erase personal data' })).toBeTruthy();
  });
});

describe('what the person is told', () => {
  it('has a message for each new refusal', () => {
    expect(
      messageFor(new ApiError('This customer has 3 order(s) in progress.', 409, 'erase_blocked')),
    ).toBe('This customer has 3 order(s) in progress.');
    expect(messageFor(new ApiError('x', 409, 'account_delete_blocked'))).toMatch(
      /only owner of a business that has other members/,
    );
    expect(messageFor(new ApiError('x', 403, 'tenant_deleted'))).toMatch(/scheduled for deletion/);
  });
});

describe('in Bangla', () => {
  const bangla = (text: string) => translate('bn', text);
  it.each([
    'Delete my account',
    'Delete this business',
    'Erase personal data',
    'Cancel deletion',
    'Type DELETE exactly as shown',
    'Type ERASE exactly as shown',
    'Incorrect password.',
    'Enter your password',
    'Your account was deleted.',
    'Your account was deleted. 2 business(es) you were the only member of will be deleted for good.',
    'This customer has 2 order(s) in progress. Finish or cancel them first, then erase the customer.',
    'A business you are the only member of is deleted for good after 14 days, and nobody can cancel that once you are gone. If you are the only owner of a business that has other members, make someone else an owner or remove the other members first.',
    'Everyone in this business is blocked at once, and it is deleted for good after 14 days. You can cancel until then.',
    'This business is scheduled for deletion on Wednesday, 4 November 2026. Nobody can use it until then.',
    'Shop is scheduled for deletion',
    'Switch to Other Shop',
    'It will be deleted for good on 4 Nov 2026, 16:00.',
    'This customer’s personal data was erased on 21 Oct 2026, 16:00. The name and phone shown are placeholders. Orders keep their totals, statuses and dates.',
    messageFor(new ApiError('x', 409, 'account_delete_blocked')),
    messageFor(new ApiError('x', 403, 'tenant_deleted')),
  ])('translates %s', (text) => {
    const out = bangla(text);
    expect(out).not.toBe(text);
    expect(out).toMatch(/[ঀ-৿]/);
    expect(out).not.toMatch(/\{\w+\}/); // no placeholder left over
  });
  it('keeps the typed word and the business name as they are', () => {
    expect(bangla('Type DELETE exactly as shown')).toContain('DELETE');
    expect(bangla('Switch to Other Shop')).toContain('Other Shop');
  });
});
