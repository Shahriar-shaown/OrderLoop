import type { Metadata } from 'next';
import { ShipmentsScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Couriers & shipments' };

export default function Page() {
  return <ShipmentsScreen />;
}
