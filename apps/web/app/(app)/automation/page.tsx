import type { Metadata } from 'next';
import { AutomationSettingsScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Automation' };

export default function Page() {
  return <AutomationSettingsScreen />;
}
