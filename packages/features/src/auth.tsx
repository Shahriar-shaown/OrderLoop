import type { AuthResult } from '@orderloop/contracts';
import { useNavigation } from '@orderloop/ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { setBusinessTimezone } from './format';
import { useRuntime } from './runtime';
import type { SessionStatus } from './session';

interface AuthValue {
  status: SessionStatus;
  session: AuthResult | null;
  signIn(
    body: Parameters<ReturnType<typeof useRuntime>['api']['auth']['login']>[0],
  ): Promise<AuthResult>;
  signUp(
    body: Parameters<ReturnType<typeof useRuntime>['api']['auth']['register']>[0],
  ): Promise<AuthResult>;
  acceptInvitation(
    body: Parameters<ReturnType<typeof useRuntime>['api']['auth']['acceptInvitation']>[0],
  ): Promise<AuthResult>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

// On the server there is never a session: it exists only in the app's memory.
const SERVER_SNAPSHOT = { status: 'loading', session: null } as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const { api, session: manager } = useRuntime();
  const snap = useSyncExternalStore(manager.subscribe, manager.getSnapshot, () => SERVER_SNAPSHOT);

  // Set while rendering, not in an effect: the screens below read it in the same pass. Setting it again is harmless.
  setBusinessTimezone(snap.session?.tenant.timezone);

  useEffect(() => {
    // Restore the session from the refresh token. init() shares one request, so StrictMode's double effect is harmless.
    manager.init().catch(() => undefined);
  }, [manager]);

  const signIn = useCallback<AuthValue['signIn']>(
    async (body) => {
      const result = await api.auth.login(body);
      manager.start(result);
      return result;
    },
    [api, manager],
  );
  const signUp = useCallback<AuthValue['signUp']>(
    async (body) => {
      const result = await api.auth.register(body);
      manager.start(result);
      return result;
    },
    [api, manager],
  );
  const acceptInvitation = useCallback<AuthValue['acceptInvitation']>(
    async (body) => {
      const result = await api.auth.acceptInvitation(body);
      manager.start(result);
      return result;
    },
    [api, manager],
  );
  const signOut = useCallback(() => manager.logout(), [manager]);

  const value = useMemo<AuthValue>(
    () => ({
      status: snap.status,
      session: snap.session,
      signIn,
      signUp,
      acceptInvitation,
      signOut,
    }),
    [snap, signIn, signUp, acceptInvitation, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AppProviders>');
  return value;
}

/** For screens that need a signed-in user: sends anonymous visitors to sign in, remembering where they were going. */
export function useRequireAuth(): AuthValue {
  const auth = useAuth();
  const navigation = useNavigation();
  const { pathname } = navigation;
  useEffect(() => {
    if (auth.status === 'anonymous')
      navigation.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [auth.status, pathname]);
  return auth;
}
