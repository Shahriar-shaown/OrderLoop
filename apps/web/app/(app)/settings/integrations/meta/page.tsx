import type { Metadata } from 'next';
import { MetaIntegrationsScreen } from '@/components/screens';
import { one, type SearchParams } from '@/lib/params';

export const metadata: Metadata = { title: 'Integrations' };

/** Also where the sign-in with Meta returns to: `?session=` to choose Pages, `?error=` when it did not work. */
export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  return <MetaIntegrationsScreen session={one(query.session)} error={one(query.error)} />;
}
