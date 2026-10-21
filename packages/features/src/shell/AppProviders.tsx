import {
  BreakpointProvider,
  I18nProvider,
  NavigationContext,
  ThemeProvider,
  ToastProvider,
  useLocale,
  type Locale,
  type LocaleStore,
  type Navigation,
} from '@orderloop/ui';
import type { ReactNode } from 'react';
import { AuthProvider } from '../core/auth';
import { QueryProvider } from '../core/query';
import { RuntimeProvider, type Runtime } from '../core/runtime';
import { setFormatLocale } from '../lib/format';
import { PushRegistration } from './PushRegistration';

/** Gives the chosen language to the date formatters, which run outside React. Set while rendering, so the screens below read it in the same pass. */
function FormatLocale({ children }: { children: ReactNode }) {
  setFormatLocale(useLocale().locale);
  return <>{children}</>;
}

/** Everything a screen expects to find around it, in one place, so each app mounts the same stack. */
export function AppProviders({
  runtime,
  navigation,
  language,
  children,
}: {
  runtime: Runtime;
  navigation: Navigation;
  /** The language to start in and where the person's choice is remembered. English when omitted. */
  language?: { initial?: Locale; store?: LocaleStore };
  children: ReactNode;
}) {
  return (
    <ThemeProvider>
      <BreakpointProvider>
        <I18nProvider {...(language ?? {})}>
          <FormatLocale>
            <NavigationContext.Provider value={navigation}>
              <RuntimeProvider runtime={runtime}>
                <QueryProvider>
                  <ToastProvider>
                    <AuthProvider>
                      <PushRegistration />
                      {children}
                    </AuthProvider>
                  </ToastProvider>
                </QueryProvider>
              </RuntimeProvider>
            </NavigationContext.Provider>
          </FormatLocale>
        </I18nProvider>
      </BreakpointProvider>
    </ThemeProvider>
  );
}
