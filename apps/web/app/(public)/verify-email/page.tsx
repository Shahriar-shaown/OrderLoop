import type { Metadata } from 'next';
import { VerifyEmailScreen } from '@/components/screens';
import { one, type SearchParams } from '@/lib/params';

export const metadata: Metadata = { title: 'Verify email' };

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  return <VerifyEmailScreen token={one((await searchParams).token)} />;
}
