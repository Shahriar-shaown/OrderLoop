import type { Metadata } from 'next';
import { CategoriesScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Categories' };

export default function Page() {
  return <CategoriesScreen />;
}
