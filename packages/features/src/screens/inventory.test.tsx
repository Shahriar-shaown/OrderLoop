import type { AuthResult, Product, StockLine } from '@orderloop/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../components/AppProviders';
import { SessionManager } from '../session';
import type { Runtime } from '../runtime';
import { InventoryScreen } from './InventoryScreen';
import { ProductDetailScreen } from './ProductDetailScreen';

const session = (role: AuthResult['role'] = 'OWNER'): AuthResult => ({
  accessToken: 'token',
  expiresIn: 900,
  user: { id: 'u', email: 'a@b.test', name: 'Anwar', emailVerified: true, language: 'en' },
  tenant: {
    id: 't',
    name: 'Shop',
    logoUrl: null,
    currency: 'BDT',
    timezone: 'Asia/Dhaka',
    defaultLanguage: 'en',
  },
  role,
  memberships: [],
});

const line: StockLine = {
  variantId: 'v1',
  sku: 'VASE-1',
  productName: 'Glass vase',
  variantName: '',
  locationId: 'l1',
  locationName: 'Main warehouse',
  onHand: 10,
  reserved: 2,
  available: 8,
  damaged: 0,
  reorderPoint: 0,
};

/** The shared screens, mounted the way both apps mount them, over a fake API that records what the screen sends. */
function mount(
  ui: React.ReactElement,
  api: Record<string, unknown>,
  role: AuthResult['role'] = 'OWNER',
) {
  const manager = new SessionManager({
    refresh: async () => session(role),
    logout: async () => undefined,
  });
  const runtime = { api, session: manager, home: '/products' } as unknown as Runtime;
  const navigation = { pathname: '/inventory', push: vi.fn(), replace: vi.fn(), back: vi.fn() };
  return render(
    <AppProviders runtime={runtime} navigation={navigation}>
      {ui}
    </AppProviders>,
  );
}

const stockApi = (extra: Record<string, unknown> = {}) => ({
  locations: {
    list: async () => [{ id: 'l1', name: 'Main warehouse', isDefault: true, archived: false }],
  },
  inventory: {
    list: async () => ({ items: [line], nextCursor: null }),
    damage: vi.fn(async () => ({})),
    writeOff: vi.fn(async () => ({})),
    return: vi.fn(async () => ({})),
    receive: vi.fn(async () => ({})),
    adjust: vi.fn(async () => ({})),
    lowStock: async () => [],
    movements: async () => ({ items: [], nextCursor: null }),
  },
  ...extra,
});

describe('stock screen: damaged stock', () => {
  it('shows damaged units and refuses a damage request without a reason, before calling the API', async () => {
    const api = stockApi();
    mount(<InventoryScreen />, api);
    const row = await screen.findByRole('row', { name: /VASE-1/ });
    expect(within(row).getByText('Main warehouse')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Damaged' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Quantity/), '3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as damaged' }));
    expect(await within(dialog).findByText('Say why (at least 3 characters)')).toBeTruthy();
    expect(api.inventory.damage).not.toHaveBeenCalled();
  });

  it('sends the quantity, the reason and one idempotency key', async () => {
    const api = stockApi();
    mount(<InventoryScreen />, api);
    const row = await screen.findByRole('row', { name: /VASE-1/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Damaged' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Quantity/), '3');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Cracked in transit');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as damaged' }));
    await waitFor(() => expect(api.inventory.damage).toHaveBeenCalledTimes(1));
    expect(api.inventory.damage).toHaveBeenCalledWith(
      expect.objectContaining({
        variantId: 'v1',
        quantity: 3,
        reason: 'Cracked in transit',
        locationId: 'l1',
        idempotencyKey: expect.stringMatching(/^app-/),
      }),
    );
  });

  it('records a return with its condition, reference and a key', async () => {
    const api = stockApi();
    mount(<InventoryScreen />, api);
    const row = await screen.findByRole('row', { name: /VASE-1/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Return' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Quantity/), '2');
    await userEvent.type(within(dialog).getByLabelText(/Reference/), 'RET-5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record a return' }));
    await waitFor(() => expect(api.inventory.return).toHaveBeenCalledTimes(1));
    expect(api.inventory.return).toHaveBeenCalledWith(
      expect.objectContaining({
        quantity: 2,
        condition: 'RESALEABLE',
        referenceType: 'return',
        referenceId: 'RET-5',
        idempotencyKey: expect.stringMatching(/^app-/),
      }),
    );
  });

  it('offers no stock actions to a role that may not write stock', async () => {
    mount(<InventoryScreen />, stockApi(), 'ACCOUNTANT');
    const row = await screen.findByRole('row', { name: /VASE-1/ });
    expect(within(row).queryByRole('button', { name: 'Damaged' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Return' })).toBeNull();
  });
});

describe('product page', () => {
  const product: Product = {
    id: 'p1',
    name: 'Handloom panjabi',
    description: 'Eid collection',
    categoryId: null,
    supplierId: 's1',
    imageUrls: ['https://cdn.example.test/a.jpg'],
    unit: 'pcs',
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    variants: [
      {
        id: 'v1',
        productId: 'p1',
        sku: 'PAN-R-M',
        name: 'Red / M',
        attributes: { colour: 'Red', size: 'M' },
        priceMinor: 185000,
        costMinor: 110050,
        barcode: null,
        reorderPoint: 3,
        archived: false,
        stock: { onHand: 7, reserved: 1, available: 6, damaged: 2 },
      },
    ],
  };

  it('shows supplier, picture, price in taka and damaged units; damaged stock can be written off', async () => {
    const api = {
      products: { get: async () => product },
      categories: { list: async () => [] },
      suppliers: {
        list: async () => [{ id: 's1', name: 'Dhaka Weavers', archived: false }],
      },
      locations: { list: async () => [] },
      inventory: { writeOff: vi.fn(async () => ({})) },
    };
    mount(<ProductDetailScreen id="p1" />, api);
    expect(await screen.findByText('Dhaka Weavers')).toBeTruthy();
    expect(screen.getByText('৳1,850.00')).toBeTruthy();
    expect(screen.getByRole('img', { name: /picture 1/ })).toBeTruthy();
    const row = screen.getByRole('row', { name: /PAN-R-M/ });
    expect(within(row).getByText('2')).toBeTruthy(); // damaged
    await userEvent.click(within(row).getByRole('button', { name: 'Write off' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Quantity/), '2');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Disposed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Write off damaged' }));
    await waitFor(() => expect(api.inventory.writeOff).toHaveBeenCalledTimes(1));
  });
});
