import type { Metadata } from 'next';
import { FinanceIssuesScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Unmatched lines and discrepancies' };

export default function Page() {
  return <FinanceIssuesScreen />;
}
