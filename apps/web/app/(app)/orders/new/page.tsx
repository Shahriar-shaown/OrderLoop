import type { Metadata } from 'next';
import { NewOrderScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'New order' };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const { customerId } = await searchParams;
  return <NewOrderScreen customerId={customerId} />;
}
