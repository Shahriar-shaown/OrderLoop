import type { Metadata } from 'next';
import { InventoryScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Stock' };

export default function Page() {
  return <InventoryScreen />;
}
