import type { Metadata } from 'next';
import { CustomersScreen } from '@/components/screens';
import { one, type SearchParams } from '@/lib/params';

export const metadata: Metadata = { title: 'Customers' };

/** The create menu links here with `?new=1` to open the new-customer form. */
export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const { new: openNew } = await searchParams;
  return <CustomersScreen openNew={one(openNew) === '1'} />;
}
