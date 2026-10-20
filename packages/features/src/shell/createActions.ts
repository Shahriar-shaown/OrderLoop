import type { IconName } from '@orderloop/ui';
import { useCan } from '../core/permissions';

export interface CreateAction {
  key: string;
  label: string;
  icon: IconName;
  href: string;
}

/** What this person can start from anywhere (the web "Quick create", the phone "+"). Empty when their role can create nothing. */
export function useCreateActions(): CreateAction[] {
  const can = useCan();
  return [
    ...(can('orders:write')
      ? [{ key: 'order', label: 'New order', icon: 'box' as const, href: '/orders/new' }]
      : []),
    ...(can('catalog:write')
      ? [{ key: 'product', label: 'New product', icon: 'layers' as const, href: '/products/new' }]
      : []),
    ...(can('orders:write')
      ? [
          {
            key: 'customer',
            label: 'New customer',
            icon: 'users' as const,
            href: '/customers?new=1',
          },
        ]
      : []),
  ];
}
