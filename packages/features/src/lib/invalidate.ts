import type { QueryClient } from '@tanstack/react-query';

/** Refresh every cached query that starts with one of these keys. */
export const invalidateKeys = (client: QueryClient, keys: readonly string[]) =>
  Promise.all(keys.map((k) => client.invalidateQueries({ queryKey: [k] })));

/** What shows products and stock. The dashboard (low stock) and search (products) read them too. */
const CATALOG_KEYS = [
  'products',
  'product',
  'inventory',
  'lowStock',
  'movements',
  'reservations',
  'dashboard',
  'global-search',
] as const;

/** After anything that changes a product, a variant, a location or stock. */
export const invalidateCatalog = (client: QueryClient) => invalidateKeys(client, CATALOG_KEYS);

const ORDER_KEYS = [
  'orders',
  'order',
  'orderDuplicates',
  'customers',
  'customer',
  'customerOrders',
  'orderCash',
] as const;

/** After anything that changes an order: its lists, its page, the customer's counts, the stock figures and the dashboard. */
export const invalidateOrders = (client: QueryClient) =>
  Promise.all([invalidateKeys(client, ORDER_KEYS), invalidateCatalog(client)]);
