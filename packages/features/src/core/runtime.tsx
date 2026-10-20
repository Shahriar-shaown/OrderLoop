import type { AuthResult } from '@orderloop/contracts';
import { createApiClient, type ApiClient, type ApiClientOptions } from '@orderloop/api-client';
import { createContext, useContext, type ReactNode } from 'react';
import { browserConnectivity, withOfflineGuard, type ConnectivityStore } from './connectivity';
import { SessionManager, withTokenRetry } from './session';

/** The two long-lived objects of a running app: the API client and the signed-in session. One pair per app instance. */
export interface Runtime {
  api: ApiClient;
  session: SessionManager;
  /** Where a signed-in person lands: the first screen of the app. */
  home: string;
  /** Whether the device is online; writes are refused while it is not (see `withOfflineGuard`). */
  connectivity: ConnectivityStore;
}

/** Device storage for the refresh token, for apps that cannot use an HttpOnly cookie (the native apps). */
export interface RefreshTokenStore {
  get(): Promise<string | null>;
  set(token: string | null): Promise<void>;
}

/**
 * Wire an API client to a session manager. The platform decides how the refresh token travels: the web app passes
 * `headers: { 'x-client': 'web' }` and `credentials: 'include'` (an HttpOnly cookie); the mobile app will pass nothing and
 * keep the refresh token in the device's secure storage.
 */
export function createRuntime(
  options: Pick<ApiClientOptions, 'baseUrl' | 'headers' | 'credentials'> & {
    /** Native apps: keep the refresh token here and send it in the request body. Omit on the web (cookie). */
    refreshTokenStore?: RefreshTokenStore;
    home?: string;
    /** The platform's network state. The web app defaults to the browser's; the mobile app passes its own. */
    connectivity?: ConnectivityStore;
  },
): Runtime {
  const store = options.refreshTokenStore;
  const connectivity = options.connectivity ?? browserConnectivity();
  const shared = {
    baseUrl: options.baseUrl,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  };
  const raw = createApiClient(shared);
  const session = new SessionManager({
    refresh: async (expectedTenantId) => {
      if (!store) return raw.auth.refresh({ expectedTenantId });
      const refreshToken = await store.get();
      // No stored token: there is no session to restore. Same shape as a refused refresh, so the app shows sign-in.
      if (!refreshToken) throw Object.assign(new Error('No session'), { status: 401 });
      return raw.auth.refresh({ refreshToken, expectedTenantId });
    },
    logout: () => api.auth.logout(),
    ...(store
      ? {
          persist: async (next: AuthResult | null) => {
            if (next === null) await store.set(null);
            // Refresh tokens rotate: every response that carries one replaces the stored one.
            else if (next.refreshToken) await store.set(next.refreshToken);
          },
        }
      : {}),
  });
  const api: ApiClient = createApiClient({
    ...shared,
    getAccessToken: session.getAccessToken,
    fetch: withOfflineGuard(
      withTokenRetry((...args) => fetch(...args), session),
      connectivity,
    ),
  });
  return { api, session, home: options.home ?? '/dashboard', connectivity };
}

const RuntimeContext = createContext<Runtime | null>(null);

export function RuntimeProvider({ runtime, children }: { runtime: Runtime; children: ReactNode }) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('useRuntime must be used inside <AppProviders>');
  return runtime;
}

export const useApi = (): ApiClient => useRuntime().api;
