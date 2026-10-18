import type { Metadata } from 'next';
import { SettlementDetailScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Settlement' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <SettlementDetailScreen id={(await params).id} />;
}
