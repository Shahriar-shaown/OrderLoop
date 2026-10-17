import type { Metadata } from 'next';
import { ForgotPasswordScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Reset password' };

export default function Page() {
  return <ForgotPasswordScreen />;
}
