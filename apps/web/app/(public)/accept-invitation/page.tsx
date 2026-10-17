import type { Metadata } from 'next';
import { AcceptInvitationScreen } from '@/components/screens';
import { one, type SearchParams } from '@/lib/params';

export const metadata: Metadata = { title: 'Accept invitation' };

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  return <AcceptInvitationScreen token={one((await searchParams).token)} />;
}
