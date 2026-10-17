import { NavigationContext, ThemeProvider, ToastProvider, type Navigation } from '@orderloop/ui';
import type { ReactNode } from 'react';
import { AuthProvider } from '../auth';
import { QueryProvider } from '../query';
import { RuntimeProvider, type Runtime } from '../runtime';

/** Everything a screen expects to find around it, in one place, so each app mounts the same stack. */
export function AppProviders({
  runtime,
  navigation,
  children,
}: {
  runtime: Runtime;
  navigation: Navigation;
  children: ReactNode;
}) {
  return (
    <ThemeProvider>
      <NavigationContext.Provider value={navigation}>
        <RuntimeProvider runtime={runtime}>
          <QueryProvider>
            <ToastProvider>
              <AuthProvider>{children}</AuthProvider>
            </ToastProvider>
          </QueryProvider>
        </RuntimeProvider>
      </NavigationContext.Provider>
    </ThemeProvider>
  );
}
