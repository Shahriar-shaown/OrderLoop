'use client';

import { AppProviders } from '@orderloop/features';
import type { Navigation } from '@orderloop/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { localeStore } from '@/lib/localeStore';
import { runtime } from '@/lib/runtime';

const language = { store: localeStore };

/** The web app's only platform glue: Next's router behind the shared `Navigation` interface, then the shared providers. */
export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const navigation = useMemo<Navigation>(
    () => ({
      pathname,
      push: (href) => router.push(href),
      replace: (href) => router.replace(href),
      // Opened straight from a link there is nothing to go back to: go to the start instead (as the mobile app does).
      back: () => (window.history.length > 1 ? router.back() : router.replace('/')),
    }),
    [pathname, router],
  );
  return (
    <AppProviders runtime={runtime} navigation={navigation} language={language}>
      {children}
    </AppProviders>
  );
}
