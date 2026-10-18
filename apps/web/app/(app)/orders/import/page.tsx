import type { Metadata } from 'next';
import { OrdersImportScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Import orders' };

export default function Page() {
  return <OrdersImportScreen />;
}
