import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV } from './nav';

const APP = join(import.meta.dirname, '../app');
/** Does expo-router have a file for this path? (`/products/[id]` style files count for any id.) */
const hasRoute = (href: string): boolean => {
  const path = href.replace(/^\//, '');
  const candidates = [
    `${path}.tsx`,
    join(path, 'index.tsx'),
    ...(path.includes('/') ? [`${path.replace(/\/[^/]+$/, '')}/[id].tsx`] : []),
  ];
  return candidates.some((c) => existsSync(join(APP, c)));
};

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
    expect(hasRoute('/orders')).toBe(false);
  });
});
