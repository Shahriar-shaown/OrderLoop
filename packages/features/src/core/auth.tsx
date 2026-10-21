import type { AuthResult } from '@orderloop/contracts';
import { useNavigation, useToast } from '@orderloop/ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { messageFor } from '../forms/errors';
import { setBusinessTimezone } from '../lib/format';
import { useRuntime } from './runtime';
import type { EndedBy, SessionStatus } from './session';

interface AuthValue {
  status: SessionStatus;
  session: AuthResult | null;
  /** Set when the session ended without the person signing out (see `Snapshot.endedBy`), so sign-in can explain. */
  endedBy: EndedBy | undefined;
  /** Restoring the saved session failed for lack of a connection (not because it is invalid): show a retry, not a spinner. */
  restoreFailed: boolean;
  retryRestore(): void;
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
  const { api, session: manager, push } = useRuntime();
  const snap = useSyncExternalStore(manager.subscribe, manager.getSnapshot, () => SERVER_SNAPSHOT);

  // Set while rendering, not in an effect: the screens below read it in the same pass. Setting it again is harmless.
  setBusinessTimezone(snap.session?.tenant.timezone);

  const [restoreFailed, setRestoreFailed] = useState(false);
  const restore = useCallback(() => {
    setRestoreFailed(false);
    // init() shares one request, so StrictMode's double effect is harmless. A refusal becomes "anonymous"; anything else
    // (no connection, server down) leaves the state alone, so it has to be shown.
    manager.init().catch(() => setRestoreFailed(true));
  }, [manager]);
  useEffect(restore, [restore]);

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
  // The server forgets this phone first (while the session can still ask it to), but never holds sign-out up: it is best effort.
  // If signing out then fails (no connection) the person stays signed in, so the phone is registered again.
  const signOut = useCallback(async () => {
    await push?.unregister();
    try {
      await manager.logout();
    } catch (error) {
      void push?.sync();
      throw error;
    }
  }, [manager, push]);

  const value = useMemo<AuthValue>(
    () => ({
      status: snap.status,
      session: snap.session,
      endedBy: snap.endedBy,
      restoreFailed: restoreFailed && snap.status === 'loading',
      retryRestore: restore,
      signIn,
      signUp,
      acceptInvitation,
      signOut,
    }),
    [snap, restoreFailed, restore, signIn, signUp, acceptInvitation, signOut],
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

/** Sign out and go to the sign-in screen. If the server cannot be reached the person stays signed in and is told why. */
export function useSignOut(): { signOut: () => Promise<void>; leaving: boolean } {
  const { signOut: end } = useAuth();
  const navigation = useNavigation();
  const toast = useToast();
  const [leaving, setLeaving] = useState(false);
  const signOut = async () => {
    setLeaving(true);
    try {
      await end();
      navigation.replace('/login');
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setLeaving(false);
    }
  };
  return { signOut, leaving };
}
