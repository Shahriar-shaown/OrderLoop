import type { Metadata } from 'next';
import { SuppliersScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Suppliers' };

export default function Page() {
  return <SuppliersScreen />;
}
