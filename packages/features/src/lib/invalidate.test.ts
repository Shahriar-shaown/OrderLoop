import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { invalidateFinance } from './finance';
import { invalidateShipments } from './couriers';
import { invalidateCatalog, invalidateOrders } from './invalidate';

const keysAfter = async (run: (client: QueryClient) => Promise<unknown>) => {
  const client = new QueryClient();
  const spy = vi.spyOn(client, 'invalidateQueries');
  await run(client);
  return spy.mock.calls.map(([filter]) => (filter?.queryKey as string[])[0]);
};

describe('what a change refreshes', () => {
  it('a product, variant, location or stock change refreshes products, stock, low stock, the dashboard and search', async () => {
    expect(await keysAfter(invalidateCatalog)).toEqual(
      expect.arrayContaining([
        'products',
        'product',
        'inventory',
        'lowStock',
        'dashboard',
        'global-search',
      ]),
    );
  });

  it('an order, shipment or finance change refreshes the dashboard and search too', async () => {
    for (const run of [invalidateOrders, invalidateShipments, invalidateFinance])
      expect(await keysAfter(run)).toEqual(
        expect.arrayContaining(['orders', 'inventory', 'lowStock', 'dashboard', 'global-search']),
      );
  });
});
