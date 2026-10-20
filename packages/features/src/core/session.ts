import { ApiError, defaultTimeoutMs } from '@orderloop/api-client';
import type { AuthResult } from '@orderloop/contracts';

/**
 * The browser's signed-in state. Framework-free so it can be tested without React.
 *
 * Security model (docs/architecture.md section 4): the short-lived access token lives only in this object's memory, never
 * in localStorage, sessionStorage or a cookie; the long-lived refresh token is an HttpOnly cookie the page cannot read.
 * After a reload there is no token in memory, so the session is restored by asking the API to refresh using the cookie.
 *
 * Refresh tokens are single use, and presenting an old one signs the user out everywhere (reuse detection). So two
 * refreshes must never run at once, whether from React StrictMode's double effects, two components that both noticed an
 * expired token, or two browser tabs. Within a tab they share one in-flight promise; across tabs they queue on a Web Lock
 * (the cookie jar is shared, so the second tab then sends the cookie the first one just received).
 */
export type SessionStatus = 'loading' | 'anonymous' | 'authenticated';

export interface SessionApi {
  /** `expectedTenantId` is the business this client is in; the server refuses (409 `tenant_changed`) when the session is in another. */
  refresh(expectedTenantId?: string): Promise<AuthResult>;
  logout(): Promise<unknown>;
  /**
   * Called whenever the session is adopted or cleared (never for tokens in flight). Native apps use it to keep the
   * rotated refresh token in secure storage; the web needs nothing because its refresh token is an HttpOnly cookie.
   */
  persist?(session: AuthResult | null): void | Promise<void>;
}

/** Why a session ended without the person signing out: the server stopped accepting it, or another tab moved to another business. */
export type EndedBy = 'expired' | 'tenant_changed';

export interface Snapshot {
  status: SessionStatus;
  session: AuthResult | null;
  /** Why there is no session, as opposed to the person signing out. */
  endedBy?: EndedBy;
}

type Message = { type: 'session'; session: AuthResult } | { type: 'logout' };

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;
const MIN_DELAY_MS = 5_000;
const LOCK_NAME = 'orderloop-session-refresh';
export const TENANT_CHANGED_MESSAGE =
  'You switched business in another tab. Reload to continue in that business.';
export const SIGN_OUT_FAILED =
  'Could not sign out because the server cannot be reached. You are still signed in. Connect and try again.';

export const isTenantChanged = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'tenant_changed';

export function isAuthRejection(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 401 || status === 403;
}

export class SessionManager {
  private snapshot: Snapshot = { status: 'loading', session: null };
  private listeners = new Set<() => void>();
  private inflight: Promise<AuthResult | null> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** When another tab last handed us a fresh session. */
  private externalAt = 0;
  private channel: BroadcastChannel | null = null;
  /** Raised whenever the session is replaced or ended, so a refresh that was already under way cannot undo that. */
  private epoch = 0;

  constructor(
    private readonly api: SessionApi,
    private readonly now: () => number = Date.now,
  ) {
    // Only in a browser: the server renders pages but never holds a session.
    if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('orderloop-session');
      this.channel.onmessage = (event: MessageEvent<Message>) => this.onMessage(event.data);
    }
  }

  // ---- React integration (useSyncExternalStore) -------------------------------------------------------------------
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): Snapshot => this.snapshot;
  getAccessToken = (): string | undefined => this.snapshot.session?.accessToken;

  private set(next: Snapshot): void {
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------
  /** Restore a session after a page load, using the refresh cookie. Safe to call more than once. */
  init(): Promise<AuthResult | null> {
    return this.refresh();
  }

  /** Adopt a session obtained by sign-in, sign-up or accepting an invitation. */
  start(session: AuthResult): void {
    this.epoch += 1;
    this.setSession(session);
    this.channel?.postMessage({ type: 'session', session } satisfies Message);
  }

  /** Adopt the session of another business: a switch creates a new session (with its own refresh token), see `AuthService.switchTenant`. */
  update(session: AuthResult): void {
    this.setSession(session);
  }

  /**
   * Revoke the session on the server, then clear it here. If the server cannot be reached this refuses and changes nothing:
   * clearing only the local state would leave the refresh token valid, and the next page load would sign the person back in.
   * Any answer from the server (even "already signed out") means the session is gone, so then the local state is cleared too.
   */
  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } catch (error) {
      if (error instanceof ApiError && !error.status)
        throw new ApiError(SIGN_OUT_FAILED, undefined, 'offline');
    }
    this.clear();
    this.channel?.postMessage({ type: 'logout' } satisfies Message);
  }

  /**
   * Exchange the refresh cookie for a new session. Concurrent callers share one request. Resolves to the new session,
   * or null when there is no valid session (then the state becomes anonymous). Network failures reject and leave the
   * current state alone, so a flaky connection does not sign anyone out.
   */
  refresh(): Promise<AuthResult | null> {
    if (this.inflight) return this.inflight;
    const waitingSince = this.now();
    const run = async (): Promise<AuthResult | null> => {
      // Another tab refreshed while we queued for the lock: use its result instead of replaying the cookie.
      if (this.externalAt >= waitingSince && this.snapshot.session) return this.snapshot.session;
      const startedAt = this.epoch;
      try {
        const session = await this.api.refresh(this.snapshot.session?.tenant.id);
        // Signed out (or in again) while this request was in flight: its answer belongs to a session that no longer exists.
        if (this.epoch !== startedAt) return this.snapshot.session;
        this.setSession(session);
        this.channel?.postMessage({ type: 'session', session } satisfies Message);
        return session;
      } catch (error) {
        // Likewise a refusal that arrives after the person signed in (a slow start-up restore): it is about the old state.
        if (this.epoch !== startedAt) return this.snapshot.session;
        if (isTenantChanged(error)) {
          // The shared cookie now holds a session in another business (a second tab switched). Nothing was rotated; do not
          // quietly adopt that business under screens that are showing this one: end the session here and say why.
          this.clear('tenant_changed');
          return null;
        }
        if (isAuthRejection(error)) {
          // A session that was running and is now refused has expired or been revoked: the sign-in screen says so.
          this.clear(this.snapshot.status === 'authenticated' ? 'expired' : undefined);
          return null;
        }
        throw error;
      }
    };
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    const guarded = locks ? locks.request(LOCK_NAME, run) : run();
    this.inflight = guarded.finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  // ---- internals --------------------------------------------------------------------------------------------------
  private persist(session: AuthResult | null): void {
    try {
      Promise.resolve(this.api.persist?.(session)).catch(() => undefined);
    } catch {
      // Storage trouble must never break the in-memory session.
    }
  }

  private setSession(session: AuthResult): void {
    this.persist(session);
    this.set({ status: 'authenticated', session });
    this.schedule(session.expiresIn);
  }

  private clear(endedBy?: EndedBy): void {
    this.epoch += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.persist(null);
    this.set({ status: 'anonymous', session: null, ...(endedBy ? { endedBy } : {}) });
  }

  private schedule(expiresInSeconds: number): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(MIN_DELAY_MS, expiresInSeconds * 1000 - REFRESH_MARGIN_MS);
    this.timer = setTimeout(() => {
      // A failed background refresh (offline, say) is retried on the next API call that gets a 401.
      this.refresh().catch(() => undefined);
    }, delay);
  }

  private onMessage(message: Message): void {
    if (message.type === 'logout') {
      this.clear();
    } else if (message.type === 'session') {
      this.externalAt = this.now();
      this.setSession(message.session);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.channel?.close();
    this.listeners.clear();
  }
}

/**
 * Wrap fetch so a 401 on an authenticated request triggers one refresh and one retry with the new token. The auth
 * endpoints themselves are never retried (a 401 from login means wrong password, not an expired session).
 */
export function withTokenRetry(
  base: typeof fetch,
  manager: Pick<SessionManager, 'refresh'>,
): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (
      response.status !== 401 ||
      !headers.authorization ||
      /\/v1\/auth\/(login|register|refresh|accept-invitation)/.test(url)
    ) {
      return response;
    }
    const fresh = await manager.refresh().catch(() => null);
    if (!fresh) return response;
    return base(input, {
      ...init,
      // The first attempt's timeout may be mostly used up by the refresh: the retry gets a full one of its own.
      ...(init?.signal
        ? { signal: AbortSignal.timeout(defaultTimeoutMs(init.method ?? 'GET')) }
        : {}),
      headers: { ...headers, authorization: `Bearer ${fresh.accessToken}` },
    });
  };
}
