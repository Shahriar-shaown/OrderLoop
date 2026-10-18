import type { Metadata } from 'next';
import { SettlementsScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Courier settlements' };

export default function Page() {
  return <SettlementsScreen />;
}
