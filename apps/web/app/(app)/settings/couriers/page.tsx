import type { Metadata } from 'next';
import { CouriersScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Couriers' };

export default function Page() {
  return <CouriersScreen />;
}
