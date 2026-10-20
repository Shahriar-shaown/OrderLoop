import { ApiError } from '@orderloop/api-client';
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { alwaysOnline } from './connectivity';
import { useRuntime } from './runtime';

/**
 * The shared data cache. It follows the device's connection: reads pause while offline and refetch on reconnect. Writes are
 * never paused (`networkMode: 'always'`): while offline they fail at once with a clear message (see `withOfflineGuard`)
 * instead of waiting in a queue to be sent later, unseen.
 */
export function QueryProvider({
  children,
  refetchOnFocus = false,
}: {
  children: ReactNode;
  /** Mobile: refetch when the app returns to the foreground, so changes made on another device show up. */
  refetchOnFocus?: boolean;
}) {
  // A hand-built runtime (in a test) may not say; then the network is assumed to be there.
  const connectivity = useRuntime().connectivity ?? alwaysOnline;
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: refetchOnFocus,
            refetchOnReconnect: true,
            // Retrying a request the server already refused (4xx) cannot help; only transient failures are retried.
            retry: (count, error) =>
              !(error instanceof ApiError && error.status && error.status < 500) && count < 2,
          },
          mutations: { networkMode: 'always' },
        },
      }),
  );
  useEffect(() => {
    onlineManager.setOnline(connectivity.isOnline());
    return connectivity.subscribe(() => onlineManager.setOnline(connectivity.isOnline()));
  }, [connectivity]);
  useEffect(() => {
    if (!refetchOnFocus) return;
    // "Focus" on a phone is the app coming back to the foreground.
    focusManager.setEventListener((handleFocus) => {
      const sub = AppState.addEventListener('change', (state) => handleFocus(state === 'active'));
      return () => sub.remove();
    });
  }, [refetchOnFocus]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
