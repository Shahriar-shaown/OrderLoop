import type { Metadata } from 'next';
import { ResetPasswordScreen } from '@/components/screens';
import { one, type SearchParams } from '@/lib/params';

export const metadata: Metadata = { title: 'Choose a new password' };

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  return <ResetPasswordScreen token={one((await searchParams).token)} />;
}
