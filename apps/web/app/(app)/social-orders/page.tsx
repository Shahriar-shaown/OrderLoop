import type { Metadata } from 'next';
import { SocialOrdersScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Social orders' };

export default function Page() {
  return <SocialOrdersScreen />;
}
