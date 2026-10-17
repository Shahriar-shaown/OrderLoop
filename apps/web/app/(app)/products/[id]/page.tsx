import type { Metadata } from 'next';
import { ProductDetailScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Product' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <ProductDetailScreen id={(await params).id} />;
}
