import { ApiError } from '@orderloop/api-client';
import type { AuthResult, InventorySummary, Product } from '@orderloop/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../components/AppProviders';
import { SessionManager } from '../session';
import type { Runtime } from '../runtime';
import { InventoryScreen } from './InventoryScreen';
import { NewProductScreen } from './NewProductScreen';
import { ProductDetailScreen } from './ProductDetailScreen';
import { ProductsScreen } from './ProductsScreen';

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

const variant = (over: Partial<Product['variants'][number]> = {}): Product['variants'][number] => ({
  id: 'v1',
  productId: 'p1',
  sku: 'VASE-1',
  name: '',
  attributes: {},
  priceMinor: 65000,
  costMinor: 40000,
  barcode: null,
  reorderPoint: 5,
  archived: false,
  stock: { onHand: 10, reserved: 2, available: 8, damaged: 0 },
  ...over,
});
const vase: Product = {
  id: 'p1',
  name: 'Glass vase',
  description: null,
  categoryId: 'c1',
  supplierId: null,
  imageUrls: [],
  unit: 'pcs',
  status: 'ACTIVE',
  createdAt: new Date().toISOString(),
  variants: [variant()],
};
const lamp: Product = {
  ...vase,
  id: 'p2',
  name: 'Desk lamp',
  variants: [
    variant({
      id: 'v2',
      productId: 'p2',
      sku: 'LAMP-1',
      stock: { onHand: 2, reserved: 0, available: 2, damaged: 0 },
    }),
    variant({
      id: 'v3',
      productId: 'p2',
      sku: 'LAMP-2',
      stock: { onHand: 0, reserved: 0, available: 0, damaged: 0 },
    }),
  ],
};
const summary: InventorySummary = {
  products: 2,
  variants: 3,
  inventoryValueCostMinor: 846300_00,
  retailValueMinor: 1428900_00,
  missingCostVariants: 2,
  lowStockCount: 1,
  outOfStockCount: 1,
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
  const navigation = { pathname: '/products', push: vi.fn(), replace: vi.fn(), back: vi.fn() };
  const view = render(
    <AppProviders runtime={runtime} navigation={navigation}>
      {ui}
    </AppProviders>,
  );
  return { ...view, navigation };
}

const stockApi = (extra: Record<string, unknown> = {}) => ({
  products: { list: vi.fn(async () => ({ items: [vase, lamp], nextCursor: null })) },
  categories: { list: async () => [{ id: 'c1', name: 'Home' }] },
  locations: {
    list: async () => [{ id: 'l1', name: 'Main warehouse', isDefault: true, archived: false }],
  },
  inventory: {
    summary: async () => summary,
    damage: vi.fn(async () => ({})),
    writeOff: vi.fn(async () => ({})),
    return: vi.fn(async () => ({})),
    receive: vi.fn(async () => ({})),
    adjust: vi.fn(async () => ({})),
    lowStock: async (): Promise<unknown[]> => [],
    movements: async (): Promise<unknown> => ({ items: [], nextCursor: null }),
  },
  ...extra,
});

const openRowMenu = async (name: RegExp | string, item: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
};

describe('products & inventory', () => {
  it('lists products from the API with prices, stock and a status in words', async () => {
    mount(<ProductsScreen />, stockApi());
    expect(await screen.findByRole('heading', { name: 'Products & inventory' })).toBeTruthy();
    expect(
      await screen.findByText(/2 products · 3 SKUs · inventory value ৳8,46,300\.00 at cost/),
    ).toBeTruthy();
    const row = await screen.findByRole('row', { name: /Glass vase/ });
    expect(within(row).getByText('VASE-1')).toBeTruthy();
    expect(within(row).getByText('Home')).toBeTruthy();
    expect(within(row).getByText('34.6%'.replace('34.6', '38.5'))).toBeTruthy(); // margin: (650-400)/650
    expect(within(row).getByText('In stock', { selector: '*' })).toBeTruthy();
    const lampRow = screen.getByRole('row', { name: /Desk lamp/ });
    expect(
      within(lampRow).getByText('VASE-1'.replace('VASE-1', 'LAMP-1 +1 variants')),
    ).toBeTruthy();
    expect(within(lampRow).getByText(/Critical · 2 left/)).toBeTruthy();
  });

  it('shows the four figures, and says when items have no cost price', async () => {
    mount(<ProductsScreen />, stockApi());
    expect(await screen.findByRole('group', { name: /Inventory value \(cost\)/ })).toBeTruthy();
    expect(screen.getByText('2 items have no cost price')).toBeTruthy();
    expect(screen.getByRole('group', { name: /Retail value: ৳14,28,900/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Low stock: 1' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Out of stock: 1' })).toBeTruthy();
  });

  it('filters by stock level on the page', async () => {
    mount(<ProductsScreen />, stockApi());
    await screen.findByRole('row', { name: /Glass vase/ });
    await userEvent.click(screen.getByRole('button', { name: /Stock: All/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Low' }));
    await waitFor(() => expect(screen.queryByRole('row', { name: /Glass vase/ })).toBeNull());
    expect(screen.getByRole('row', { name: /Desk lamp/ })).toBeTruthy();
  });

  it('shows an error with a retry when the list cannot load', async () => {
    const api = stockApi({
      products: {
        list: vi.fn(async () => {
          throw new ApiError('Not allowed right now', 403, 'forbidden');
        }),
      },
    });
    mount(<ProductsScreen />, api);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('opens the stock dialog from a row, asks for a reason, and calls nothing until it has one', async () => {
    const api = stockApi();
    mount(<ProductsScreen />, api);
    await openRowMenu('Glass vase', 'Adjust stock');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Current stock: 8 available \(10 on hand\)/)).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText(/Change in stock/), '-3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Adjust stock' }));
    expect(await within(dialog).findByText('Say why (at least 3 characters)')).toBeTruthy();
    expect(api.inventory.adjust).not.toHaveBeenCalled();
  });

  it('adjusts stock with the quantity stepper, the reason and one idempotency key', async () => {
    const api = stockApi();
    mount(<ProductsScreen />, api);
    await openRowMenu('Glass vase', 'Adjust stock');
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Decrease by one' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Decrease by one' }));
    expect((within(dialog).getByLabelText(/Change in stock/) as HTMLInputElement).value).toBe('-2');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Stock take');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Adjust stock' }));
    await waitFor(() => expect(api.inventory.adjust).toHaveBeenCalledTimes(1));
    expect(api.inventory.adjust).toHaveBeenCalledWith(
      expect.objectContaining({
        variantId: 'v1',
        delta: -2,
        reason: 'Stock take',
        idempotencyKey: expect.stringMatching(/^app-/),
      }),
    );
  });

  it('lets the header button pick any product, then receives stock', async () => {
    const api = stockApi();
    mount(<ProductsScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust stock' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText(/Product/), 'v1');
    await userEvent.type(within(dialog).getByLabelText(/Change in stock/), '4');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Recount');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Adjust stock' }));
    await waitFor(() => expect(api.inventory.adjust).toHaveBeenCalledTimes(1));
    expect(api.inventory.adjust).toHaveBeenCalledWith(
      expect.objectContaining({ variantId: 'v1', delta: 4 }),
    );
  });

  it('receives stock from the low stock tab with an idempotency key', async () => {
    const api = stockApi();
    api.inventory.lowStock = async () => [
      {
        variantId: 'v2',
        sku: 'LAMP-1',
        productName: 'Desk lamp',
        variantName: '',
        reorderPoint: 5,
        onHand: 2,
        reserved: 0,
        available: 2,
        damaged: 0,
      },
    ];
    mount(<ProductsScreen />, api);
    await userEvent.click(await screen.findByRole('tab', { name: /Low stock/ }));
    const row = await screen.findByRole('row', { name: /LAMP-1/ });
    expect(within(row).getByText(/Critical · 2 left/)).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Receive stock' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Quantity/), '12');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Receive stock' }));
    await waitFor(() => expect(api.inventory.receive).toHaveBeenCalledTimes(1));
    expect(api.inventory.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        variantId: 'v2',
        quantity: 12,
        idempotencyKey: expect.stringMatching(/^app-/),
      }),
    );
  });

  it('offers no stock actions to a role that may not write stock', async () => {
    mount(<ProductsScreen />, stockApi(), 'ACCOUNTANT');
    await screen.findByRole('row', { name: /Glass vase/ });
    expect(screen.queryByRole('button', { name: 'Adjust stock' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Glass vase' }));
    expect(screen.queryByRole('menuitem', { name: 'Receive stock' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Open' })).toBeTruthy();
  });

  it('opens on the stock movements tab at /inventory, and shows the ledger', async () => {
    const api = stockApi();
    api.inventory.movements = async () => ({
      items: [
        {
          id: 'm1',
          type: 'RECEIVE',
          variantId: 'v1',
          sku: 'VASE-1',
          locationId: 'l1',
          onHandDelta: 30,
          reservedDelta: 0,
          damagedDelta: 0,
          reason: 'Supplier delivery',
          referenceType: null,
          referenceId: null,
          reservationId: null,
          createdById: null,
          createdAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
    });
    mount(<InventoryScreen />, api);
    const row = await screen.findByRole('row', { name: /VASE-1/ });
    expect(within(row).getByText('Received')).toBeTruthy();
    expect(within(row).getByText('+30')).toBeTruthy();
    expect(within(row).getByText('Supplier delivery')).toBeTruthy();
  });
});

describe('product page: damaged stock', () => {
  const product: Product = {
    ...vase,
    id: 'p1',
    name: 'Handloom panjabi',
    description: 'Eid collection',
    categoryId: null,
    supplierId: 's1',
    imageUrls: ['https://cdn.example.test/a.jpg'],
    variants: [
      variant({
        sku: 'PAN-R-M',
        name: 'Red / M',
        attributes: { colour: 'Red', size: 'M' },
        priceMinor: 185000,
        costMinor: 110050,
        reorderPoint: 3,
        stock: { onHand: 7, reserved: 1, available: 6, damaged: 2 },
      }),
    ],
  };
  const productApi = () => ({
    products: { get: async () => product },
    categories: { list: async () => [] },
    suppliers: { list: async () => [{ id: 's1', name: 'Dhaka Weavers', archived: false }] },
    locations: { list: async () => [] },
    inventory: {
      writeOff: vi.fn(async () => ({})),
      return: vi.fn(async () => ({})),
    },
  });

  it('shows supplier, picture, price in taka and the stock columns; damaged stock can be written off', async () => {
    const api = productApi();
    mount(<ProductDetailScreen id="p1" />, api);
    expect(await screen.findByText('Dhaka Weavers')).toBeTruthy();
    expect(screen.getByText('Products')).toBeTruthy(); // breadcrumb
    expect(screen.getAllByText('৳1,850.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: /picture 1/ })).toBeTruthy();
    const row = screen.getByRole('row', { name: /PAN-R-M/ });
    expect(within(row).getByText('2')).toBeTruthy(); // damaged
    await userEvent.click(within(row).getByRole('button', { name: 'More actions for PAN-R-M' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Write off damaged' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Quantity/), '2');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Disposed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Write off damaged' }));
    await waitFor(() => expect(api.inventory.writeOff).toHaveBeenCalledTimes(1));
    expect(api.inventory.writeOff).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 2, idempotencyKey: expect.stringMatching(/^app-/) }),
    );
  });

  it('records a return with its condition, reference and a key', async () => {
    const api = productApi();
    mount(<ProductDetailScreen id="p1" />, api);
    const row = await screen.findByRole('row', { name: /PAN-R-M/ });
    await userEvent.click(within(row).getByRole('button', { name: 'More actions for PAN-R-M' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Record a return' }));
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
});

describe('new product', () => {
  it('creates a product with its first variant and opens it', async () => {
    const create = vi.fn(async () => ({ ...vase, id: 'new1', name: 'Mug' }));
    const api = {
      products: { create },
      categories: { list: async () => [] },
      suppliers: { list: async () => [] },
    };
    const { navigation } = mount(<NewProductScreen />, api);
    await userEvent.type(await screen.findByLabelText(/Product name/), 'Mug');
    await userEvent.type(screen.getByLabelText(/SKU/), 'mug-1');
    await userEvent.type(screen.getByLabelText(/Price/), '250');
    await userEvent.click(screen.getByRole('button', { name: 'Create product' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Mug',
        variants: [expect.objectContaining({ sku: 'MUG-1', priceMinor: 25000 })],
      }),
    );
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/products/new1'));
  });

  it('shows what is missing instead of calling the API', async () => {
    const create = vi.fn();
    const api = {
      products: { create },
      categories: { list: async () => [] },
      suppliers: { list: async () => [] },
    };
    mount(<NewProductScreen />, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Create product' }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();
  });
});
