import type { Metadata } from 'next';
import { SignupScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Create account' };

export default function Page() {
  return <SignupScreen />;
}
