import type { Metadata } from 'next';
import { CustomersScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Customers' };

export default function Page() {
  return <CustomersScreen />;
}
