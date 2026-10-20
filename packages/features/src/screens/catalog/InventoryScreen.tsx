import { ProductsScreen } from './ProductsScreen';

/** `/inventory`: the products & inventory page, opened on the stock movements. */
export function InventoryScreen() {
  return <ProductsScreen initialTab="movements" />;
}
