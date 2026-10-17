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
  refresh(): Promise<AuthResult>;
  logout(): Promise<unknown>;
}

export interface Snapshot {
  status: SessionStatus;
  session: AuthResult | null;
}

type Message = { type: 'session'; session: AuthResult } | { type: 'logout' };

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;
const MIN_DELAY_MS = 5_000;
const LOCK_NAME = 'orderloop-session-refresh';

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
    this.setSession(session);
    this.channel?.postMessage({ type: 'session', session } satisfies Message);
  }

  /** Replace the session after switching tenant (the refresh token is unchanged). */
  update(session: AuthResult): void {
    this.setSession(session);
  }

  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } catch {
      // The session may already be gone; the local state must be cleared regardless.
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
      try {
        const session = await this.api.refresh();
        this.setSession(session);
        this.channel?.postMessage({ type: 'session', session } satisfies Message);
        return session;
      } catch (error) {
        if (isAuthRejection(error)) {
          this.clear();
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
  private setSession(session: AuthResult): void {
    this.set({ status: 'authenticated', session });
    this.schedule(session.expiresIn);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.set({ status: 'anonymous', session: null });
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
      headers: { ...headers, authorization: `Bearer ${fresh.accessToken}` },
    });
  };
}
