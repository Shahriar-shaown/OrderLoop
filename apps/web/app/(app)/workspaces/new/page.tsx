import type { Metadata } from 'next';
import { WorkspaceCreateScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'New business' };

export default function Page() {
  return <WorkspaceCreateScreen />;
}
