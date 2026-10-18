import type { Metadata } from 'next';
import { OrderDetailScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Order' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <OrderDetailScreen id={(await params).id} />;
}
