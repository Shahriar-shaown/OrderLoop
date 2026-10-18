import type { Metadata } from 'next';
import { WorkspacesScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Your businesses' };

export default function Page() {
  return <WorkspacesScreen />;
}
