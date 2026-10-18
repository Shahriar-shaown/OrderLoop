import type { Metadata } from 'next';
import { CustomerDetailScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Customer' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <CustomerDetailScreen id={(await params).id} />;
}
