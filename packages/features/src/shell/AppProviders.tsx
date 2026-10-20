import {
  BreakpointProvider,
  I18nProvider,
  NavigationContext,
  ThemeProvider,
  ToastProvider,
  type Locale,
  type LocaleStore,
  type Navigation,
} from '@orderloop/ui';
import type { ReactNode } from 'react';
import { AuthProvider } from '../core/auth';
import { QueryProvider } from '../core/query';
import { RuntimeProvider, type Runtime } from '../core/runtime';

/** Everything a screen expects to find around it, in one place, so each app mounts the same stack. */
export function AppProviders({
  runtime,
  navigation,
  language,
  refetchOnFocus,
  children,
}: {
  runtime: Runtime;
  navigation: Navigation;
  /** The language to start in and where the person's choice is remembered. English when omitted. */
  language?: { initial?: Locale; store?: LocaleStore };
  /** Refetch data when the app returns to the foreground (the mobile app). */
  refetchOnFocus?: boolean;
  children: ReactNode;
}) {
  return (
    <ThemeProvider>
      <BreakpointProvider>
        <I18nProvider {...(language ?? {})}>
          <NavigationContext.Provider value={navigation}>
            <RuntimeProvider runtime={runtime}>
              <QueryProvider {...(refetchOnFocus ? { refetchOnFocus } : {})}>
                <ToastProvider>
                  <AuthProvider>{children}</AuthProvider>
                </ToastProvider>
              </QueryProvider>
            </RuntimeProvider>
          </NavigationContext.Provider>
        </I18nProvider>
      </BreakpointProvider>
    </ThemeProvider>
  );
}
