import type { Metadata } from 'next';
import { SocialDraftScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Review draft order' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <SocialDraftScreen id={(await params).id} />;
}
