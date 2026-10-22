import type { Metadata } from 'next';
import { TikTokOrderScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'TikTok order' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <TikTokOrderScreen id={(await params).id} />;
}
