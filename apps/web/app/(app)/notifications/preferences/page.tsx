import type { Metadata } from 'next';
import { NotificationPreferencesScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Notification preferences' };

export default function Page() {
  return <NotificationPreferencesScreen />;
}
