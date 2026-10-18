import type { Metadata } from 'next';
import { AnalyticsScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Analytics & profit' };

export default function Page() {
  return <AnalyticsScreen />;
}
