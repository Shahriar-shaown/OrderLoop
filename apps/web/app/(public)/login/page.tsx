import type { Metadata } from 'next';
import { LoginScreen } from '@/components/screens';
import { one, type SearchParams } from '@/lib/params';

export const metadata: Metadata = { title: 'Sign in' };

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  return <LoginScreen next={one((await searchParams).next)} />;
}
