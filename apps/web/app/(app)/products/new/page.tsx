import type { Metadata } from 'next';
import { NewProductScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'New product' };

export default function Page() {
  return <NewProductScreen />;
}
