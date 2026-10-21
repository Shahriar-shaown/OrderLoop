import type { Permission } from '@orderloop/contracts';
import type { IconName } from '@orderloop/ui';

export interface ShellNavItem {
  href: string;
  label: string;
  needs?: Permission;
  icon?: IconName;
  /** Section heading in the sidebar. */
  group?: string;
}

/** The web menu, in the design's sections. Items a role may not use are left out. */
export const WEB_NAV: ShellNavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: 'home', group: 'Operations' },
  { href: '/orders', label: 'Orders', icon: 'box', group: 'Operations' },
  { href: '/products', label: 'Products & inventory', icon: 'layers', group: 'Operations' },
  { href: '/customers', label: 'Customers', icon: 'users', group: 'Operations' },
  {
    href: '/couriers',
    label: 'Couriers & shipments',
    icon: 'truck',
    needs: 'couriers:read',
    group: 'Logistics & finance',
  },
  {
    href: '/cod',
    label: 'COD reconciliation',
    icon: 'wallet',
    needs: 'finance:read',
    group: 'Logistics & finance',
  },
  {
    href: '/analytics',
    label: 'Analytics & profit',
    icon: 'bar-chart',
    needs: 'finance:read',
    group: 'Logistics & finance',
  },
  {
    href: '/team',
    label: 'Team & staff',
    icon: 'users',
    needs: 'members:read',
    group: 'Workspace',
  },
  {
    href: '/automation',
    label: 'Automation',
    icon: 'zap',
    needs: 'automation:read',
    group: 'Workspace',
  },
  { href: '/settings', label: 'Settings', icon: 'sliders', group: 'Workspace' },
];

/** The five slots of the phone's bottom bar (the middle one is "create"); everything else sits under More. */
export const BOTTOM_HREFS = ['/dashboard', '/orders', '/couriers'] as const;
