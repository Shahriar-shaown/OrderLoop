import type { Metadata } from 'next';
import { TikTokIntegrationsScreen } from '@/components/screens';
import { one, type SearchParams } from '@/lib/params';

export const metadata: Metadata = { title: 'Integrations: TikTok Shop' };

/** Also where the sign-in with TikTok returns to: `?session=` to choose shops, `?error=` when it did not work. */
export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  return <TikTokIntegrationsScreen session={one(query.session)} error={one(query.error)} />;
}
