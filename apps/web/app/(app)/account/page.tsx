import type { Metadata } from 'next';
import { AccountScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Your account' };

export default function Page() {
  return <AccountScreen />;
}
