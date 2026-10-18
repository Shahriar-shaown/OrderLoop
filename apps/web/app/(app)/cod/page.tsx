import type { Metadata } from 'next';
import { CodReconciliationScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'COD reconciliation' };

export default function Page() {
  return <CodReconciliationScreen />;
}
