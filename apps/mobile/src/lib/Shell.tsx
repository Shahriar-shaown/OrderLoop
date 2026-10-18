import { AppShell } from '@orderloop/features';
import type { ReactNode } from 'react';
import { NAV } from './nav';

/** The signed-in frame with the mobile menu. */
export function Shell({ children }: { children: ReactNode }) {
  return <AppShell nav={NAV}>{children}</AppShell>;
}
