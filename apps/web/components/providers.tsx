'use client';

import { AppProviders } from '@orderloop/features';
import type { Navigation } from '@orderloop/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { runtime } from '@/lib/runtime';

/** The web app's only platform glue: Next's router behind the shared `Navigation` interface, then the shared providers. */
export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const navigation = useMemo<Navigation>(
    () => ({
      pathname,
      push: (href) => router.push(href),
      replace: (href) => router.replace(href),
      back: () => router.back(),
    }),
    [pathname, router],
  );
  return (
    <AppProviders runtime={runtime} navigation={navigation}>
      {children}
    </AppProviders>
  );
}
