import { ApiError } from '@orderloop/api-client';

/**
 * Whether the device can reach the network, as the platform reports it. Framework-free so it can be tested without React:
 * the browser and the mobile app each feed it from their own source (online/offline events, the network state module).
 */
export interface ConnectivityStore {
  isOnline(): boolean;
  subscribe(listener: () => void): () => void;
  /** A request failed without any answer: the platform may check whether the server can really be reached. */
  reportFailure?(): void;
}

export interface WritableConnectivity extends ConnectivityStore {
  set(online: boolean): void;
}

export function createConnectivityStore(initial = true): WritableConnectivity {
  let online = initial;
  const listeners = new Set<() => void>();
  return {
    isOnline: () => online,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      if (next === online) return;
      online = next;
      listeners.forEach((l) => l());
    },
  };
}

/** Assume the network is there (tests, and platforms that cannot tell). */
export const alwaysOnline: ConnectivityStore = {
  isOnline: () => true,
  subscribe: () => () => undefined,
};

/** The browser's own online/offline state. */
export function browserConnectivity(): ConnectivityStore {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return alwaysOnline;
  const store = createConnectivityStore(navigator.onLine !== false);
  window.addEventListener('online', () => store.set(true));
  window.addEventListener('offline', () => store.set(false));
  return store;
}

export const OFFLINE_MESSAGE = 'You are offline. Nothing was sent. Connect and try again.';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Wrap fetch so that nothing which changes data is sent while the device is offline. A write that never reached the server
 * must be seen to have failed, not queued: an order, a payment or a courier booking must never go out later, on its own, with
 * values the person has since stopped looking at. Reads are left alone (they simply fail or wait, and cached data stays).
 */
export function withOfflineGuard(
  base: typeof fetch,
  connectivity: ConnectivityStore,
): typeof fetch {
  return (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (!READS.has(method) && !connectivity.isOnline())
      return Promise.reject(new ApiError(OFFLINE_MESSAGE, undefined, 'offline'));
    return base(input, init).catch((error: unknown) => {
      // No answer at all (not even an error status): let the platform find out whether the connection is gone.
      if (error instanceof TypeError) connectivity.reportFailure?.();
      throw error;
    });
  };
}
