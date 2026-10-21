import type { Metadata } from 'next';
import { ProductsScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Products' };

/** A notification links here with `?tab=low` to open the low-stock list. */
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  return <ProductsScreen tab={tab} />;
}
