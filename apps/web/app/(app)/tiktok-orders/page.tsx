import type { Metadata } from 'next';
import { TikTokOrdersScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'TikTok orders' };

export default function Page() {
  return <TikTokOrdersScreen />;
}
