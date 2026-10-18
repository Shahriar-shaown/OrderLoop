import { AppShell, type ShellNavItem } from '@orderloop/features';
import type { ReactNode } from 'react';

/** What the mobile app offers so far: the workspace screens. The catalog screens arrive with their own milestones. */
const NAV: ShellNavItem[] = [
  { href: '/workspaces', label: 'Businesses' },
  { href: '/settings', label: 'Settings' },
];

export function Shell({ children }: { children: ReactNode }) {
  return <AppShell nav={NAV}>{children}</AppShell>;
}
