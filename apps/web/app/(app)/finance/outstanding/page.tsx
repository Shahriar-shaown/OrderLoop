import type { Metadata } from 'next';
import { OutstandingCodScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Outstanding COD' };

export default function Page() {
  return <OutstandingCodScreen />;
}
