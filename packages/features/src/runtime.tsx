import { createApiClient, type ApiClient, type ApiClientOptions } from '@orderloop/api-client';
import { createContext, useContext, type ReactNode } from 'react';
import { SessionManager, withTokenRetry } from './session';

/** The two long-lived objects of a running app: the API client and the signed-in session. One pair per app instance. */
export interface Runtime {
  api: ApiClient;
  session: SessionManager;
}

/**
 * Wire an API client to a session manager. The platform decides how the refresh token travels: the web app passes
 * `headers: { 'x-client': 'web' }` and `credentials: 'include'` (an HttpOnly cookie); the mobile app will pass nothing and
 * keep the refresh token in the device's secure storage.
 */
export function createRuntime(
  options: Pick<ApiClientOptions, 'baseUrl' | 'headers' | 'credentials'>,
): Runtime {
  const shared = {
    baseUrl: options.baseUrl,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  };
  const raw = createApiClient(shared);
  const session = new SessionManager({
    refresh: () => raw.auth.refresh({}),
    logout: () => api.auth.logout(),
  });
  const api: ApiClient = createApiClient({
    ...shared,
    getAccessToken: session.getAccessToken,
    fetch: withTokenRetry((...args) => fetch(...args), session),
  });
  return { api, session };
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
