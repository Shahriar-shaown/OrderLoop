import type { Metadata } from 'next';
import { ImportsScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Import products' };

export default function Page() {
  return <ImportsScreen />;
}
