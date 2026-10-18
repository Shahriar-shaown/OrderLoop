import type { Metadata } from 'next';
import { WorkspaceSettingsScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Business settings' };

export default function Page() {
  return <WorkspaceSettingsScreen />;
}
