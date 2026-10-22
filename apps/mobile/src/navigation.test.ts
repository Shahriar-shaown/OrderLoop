import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV } from './navigation';

const APP = join(import.meta.dirname, 'app');
/**
 * Does expo-router have a file for this path? Matches the way the router does: a literal segment first, then a dynamic
 * `[param]` one, so `/orders/123/edit` is served by `orders/[id]/edit.tsx`; and a `(group)` folder is invisible in the
 * URL, so `(app)/(tabs)/orders.tsx` serves `/orders`.
 */
const resolve = (dir: string, segments: string[]): boolean => {
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const groups = names.filter((n) => /^\(.+\)$/.test(n));
  const here = (): boolean => {
    if (segments.length === 0) return existsSync(join(dir, 'index.tsx'));
    const [head, ...rest] = segments as [string, ...string[]];
    const options = [
      head,
      ...names.filter((n) => /^\[[^\]]+\](\.tsx)?$/.test(n)).map((n) => n.replace(/\.tsx$/, '')),
    ];
    return options.some((name) =>
      rest.length === 0
        ? existsSync(join(dir, `${name}.tsx`)) || resolve(join(dir, name), [])
        : resolve(join(dir, name), rest),
    );
  };
  return here() || groups.some((g) => resolve(join(dir, g), segments));
};
const hasRoute = (href: string): boolean => resolve(APP, href.split('/').filter(Boolean));

describe('mobile routes', () => {
  it('has a screen for every tab and every item under More', () => {
    for (const item of NAV) expect(hasRoute(item.href), item.href).toBe(true);
  });

  it('has the sign-in flow outside the signed-in area', () => {
    for (const href of [
      '/login',
      '/signup',
      '/forgot-password',
      '/reset-password',
      '/verify-email',
      '/accept-invitation',
    ])
      expect(hasRoute(href), href).toBe(true);
  });

  it('has the screens the shared flows navigate to', () => {
    // Paths the shared screens push or link to: sign-in, sign-up, creating things, a product's page.
    for (const href of [
      '/',
      '/login',
      '/signup',
      '/dashboard',
      '/team',
      '/orders',
      '/orders/new',
      '/orders/import',
      '/orders/123',
      '/orders/123/edit',
      '/customers',
      '/customers/123',
      '/products',
      '/products/new',
      '/products/123',
      '/inventory',
      '/suppliers',
      '/workspaces',
      '/workspaces/new',
      '/settings',
      '/social-orders',
      '/social-orders/123',
      '/settings/integrations/meta',
      '/settings/integrations/tiktok-shop',
      '/tiktok-orders',
      '/tiktok-orders/123',
      '/tiktok-orders/sku-mapping',
    ])
      expect(hasRoute(href), href).toBe(true);
  });

  it('reports a missing screen rather than assuming it exists', () => {
    expect(hasRoute('/automations')).toBe(false);
  });
});
