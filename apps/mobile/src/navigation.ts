import type { Permission } from '@orderloop/contracts';
import type { IconName } from '@orderloop/ui';

export interface MoreItem {
  href: string;
  label: string;
  icon: IconName;
  needs?: Permission;
}

/** The three screens of the tab bar besides Home: each href must have a route file (routes.test.ts checks). */
export const TABS = [
  { name: 'dashboard', href: '/dashboard', label: 'Home', icon: 'home' },
  { name: 'orders', href: '/orders', label: 'Orders', icon: 'box' },
  { name: 'couriers', href: '/couriers', label: 'Shipments', icon: 'truck' },
  { name: 'more', href: '/more', label: 'More', icon: 'more' },
] as const satisfies readonly { name: string; href: string; label: string; icon: IconName }[];

/** What sits under "More": everything the tab bar has no room for. A role only sees what it may use. */
export const MORE_ITEMS: MoreItem[] = [
  { href: '/products', label: 'Products & inventory', icon: 'layers' },
  { href: '/customers', label: 'Customers', icon: 'users' },
  { href: '/cod', label: 'COD reconciliation', icon: 'wallet', needs: 'finance:read' },
  { href: '/analytics', label: 'Analytics & profit', icon: 'bar-chart', needs: 'finance:read' },
  {
    href: '/settings/couriers',
    label: 'Courier connections',
    icon: 'plug',
    needs: 'couriers:read',
  },
  { href: '/team', label: 'Team & staff', icon: 'users', needs: 'members:read' },
  { href: '/settings', label: 'Business settings', icon: 'sliders' },
  { href: '/workspaces', label: 'Switch or add a business', icon: 'store' },
];

/** Every href the app promises to have a screen for. */
export const NAV = [...TABS, ...MORE_ITEMS];
