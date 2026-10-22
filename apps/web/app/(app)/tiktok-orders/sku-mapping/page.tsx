import type { Metadata } from 'next';
import { TikTokOrdersScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'TikTok SKU mapping' };

export default function Page() {
  return <TikTokOrdersScreen view="sku-mapping" />;
}
