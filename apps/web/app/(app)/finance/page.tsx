import type { Metadata } from 'next';
import { FinanceScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Finance' };

export default function Page() {
  return <FinanceScreen />;
}
