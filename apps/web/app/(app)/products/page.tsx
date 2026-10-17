import type { Metadata } from 'next';
import { ProductsScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Products' };

export default function Page() {
  return <ProductsScreen />;
}
