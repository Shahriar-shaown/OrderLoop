import type { Metadata } from 'next';
import { OrdersScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Orders' };

/** The dashboard links here with a status and a date range already chosen. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; from?: string; to?: string }>;
}) {
  const { status, from, to } = await searchParams;
  return <OrdersScreen initialStatus={status} initialFrom={from} initialTo={to} />;
}
