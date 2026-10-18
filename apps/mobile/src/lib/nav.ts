import type { ShellNavItem } from '@orderloop/features';

/** The mobile menu: what the app has screens for. Each href must have a route file (routes.test.ts checks). */
export const NAV: ShellNavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/orders', label: 'Orders' },
  { href: '/customers', label: 'Customers' },
  { href: '/products', label: 'Products' },
  { href: '/inventory', label: 'Stock' },
  { href: '/suppliers', label: 'Suppliers' },
  { href: '/team', label: 'Team', needs: 'members:read' },
  { href: '/workspaces', label: 'Businesses' },
  { href: '/settings', label: 'Settings' },
];
