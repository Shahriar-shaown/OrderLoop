import { ApiError } from '@orderloop/api-client';
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { alwaysOnline } from './connectivity';
import { useRuntime } from './runtime';

/**
 * The shared data cache. It follows the device's connection: reads pause while offline and refetch on reconnect. Writes are
 * never paused (`networkMode: 'always'`): while offline they fail at once with a clear message (see `withOfflineGuard`)
 * instead of waiting in a queue to be sent later, unseen.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  // A hand-built runtime (in a test) may not say; then the network is assumed to be there.
  const { connectivity = alwaysOnline, session } = useRuntime();
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            // The person coming back: the browser tab gains focus, or the phone app returns to the foreground.
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            // Retrying a request the server already refused (4xx) cannot help; only transient failures are retried.
            retry: (count, error) =>
              !(error instanceof ApiError && error.status && error.status < 500) && count < 2,
          },
          mutations: { networkMode: 'always' },
        },
      }),
  );
  // What is cached belongs to one person in one business. When either changes, or the session ends, the next person must
  // not see it (not even for the few seconds before a refetch lands).
  useEffect(() => {
    const identity = () => {
      const { session: current } = session.getSnapshot();
      return current ? `${current.user.id}:${current.tenant.id}` : null;
    };
    let last = identity();
    return session.subscribe(() => {
      const now = identity();
      // Leaving an identity (to another person or business, or to signed-out) empties the cache. Arriving from signed-out
      // needs nothing: that sign-out already did it, and the screens have just started their first queries.
      if (last !== null && now !== last) client.clear();
      last = now;
    });
  }, [session, client]);
  useEffect(() => {
    onlineManager.setOnline(connectivity.isOnline());
    return connectivity.subscribe(() => onlineManager.setOnline(connectivity.isOnline()));
  }, [connectivity]);
  useEffect(() => {
    // On the web TanStack listens to the browser's visibility changes itself. A phone has none: its focus is AppState.
    if (Platform.OS === 'web') return;
    focusManager.setEventListener((handleFocus) => {
      const sub = AppState.addEventListener('change', (state) => handleFocus(state === 'active'));
      return () => sub.remove();
    });
  }, []);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
