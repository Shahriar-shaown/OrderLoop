import type { ReactNode } from 'react';
import { AppShell } from '@/components/screens';

/** Every page inside (app) needs a signed-in user: the shell redirects anonymous visitors to /login. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
