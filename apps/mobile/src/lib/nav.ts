import type { ShellNavItem } from '@orderloop/features';

/** The mobile menu: what the app has screens for. Each href must have a route file (routes.test.ts checks). */
export const NAV: ShellNavItem[] = [
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
  { href: '/settings', label: 'Settings', icon: 'sliders', group: 'Workspace' },
];
