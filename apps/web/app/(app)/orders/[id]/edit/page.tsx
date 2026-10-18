import type { Metadata } from 'next';
import { EditOrderScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Edit order' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <EditOrderScreen id={(await params).id} />;
}
