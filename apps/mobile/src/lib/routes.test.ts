import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV } from './nav';

const APP = join(import.meta.dirname, '../app');
/**
 * Does expo-router have a file for this path? Matches the way the router does: a literal segment first, then a dynamic
 * `[param]` one, so `/orders/123/edit` is served by `orders/[id]/edit.tsx`.
 */
const resolve = (dir: string, segments: string[]): boolean => {
  if (segments.length === 0) return existsSync(join(dir, 'index.tsx'));
  const [head, ...rest] = segments as [string, ...string[]];
  const names = existsSync(dir) ? readdirSync(dir) : [];
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
const hasRoute = (href: string): boolean => resolve(APP, href.split('/').filter(Boolean));

describe('mobile routes', () => {
  it('has a screen for every menu item', () => {
    for (const item of NAV) expect(hasRoute(item.href), item.href).toBe(true);
  });

  it('has the screens the shared flows navigate to', () => {
    // Paths the shared screens push or link to: sign-in, sign-up, creating things, a product's page.
    for (const href of [
      '/',
      '/login',
      '/signup',
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
    ])
      expect(hasRoute(href), href).toBe(true);
  });

  it('reports a missing screen rather than assuming it exists', () => {
    expect(hasRoute('/couriers')).toBe(false);
  });
});
