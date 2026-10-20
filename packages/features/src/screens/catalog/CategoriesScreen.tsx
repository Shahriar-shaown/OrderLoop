import { ProductsScreen } from './ProductsScreen';

/** `/categories`: the products & inventory page, opened on its categories tab. */
export function CategoriesScreen() {
  return <ProductsScreen initialTab="categories" />;
}
