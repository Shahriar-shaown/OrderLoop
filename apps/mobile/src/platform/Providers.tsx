import { AppProviders } from '@orderloop/features';
import type { Navigation } from '@orderloop/ui';
import { usePathname, useRouter, type Href } from 'expo-router';
import { useMemo, type ReactNode } from 'react';
import { deviceLocale, localeStore } from './localeStore';
import { runtime } from './runtime';

const language = { initial: deviceLocale(), store: localeStore };

/** The mobile app's only platform glue: expo-router behind the shared `Navigation` interface, then the shared providers. */
export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const navigation = useMemo<Navigation>(
    () => ({
      pathname,
      push: (href) => router.push(href as Href),
      replace: (href) => router.replace(href as Href),
      back: () => (router.canGoBack() ? router.back() : router.replace('/' as Href)),
    }),
    [pathname, router],
  );
  return (
    <AppProviders runtime={runtime} navigation={navigation} language={language} refetchOnFocus>
      {children}
    </AppProviders>
  );
}
