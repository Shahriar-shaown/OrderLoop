import type { Metadata } from 'next';
import { DashboardScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Dashboard' };

export default function Page() {
  return <DashboardScreen />;
}
