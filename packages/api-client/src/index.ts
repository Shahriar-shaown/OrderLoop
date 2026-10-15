import {
  Problem,
  routes,
  type RouteInput,
  type RouteOutput,
  type RouteSpec,
} from '@orderloop/contracts';

export interface ApiClientOptions {
  /** API origin, e.g. http://localhost:4000 (no trailing path). */
  baseUrl: string;
  /** Injectable for tests and non-standard runtimes. Defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Supplies the current access token for routes that require one. */
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
  /** Sent on every request, e.g. `{ 'x-client': 'web' }` to receive the refresh token as an HttpOnly cookie. */
  headers?: Record<string, string>;
  /** Pass `include` in browsers so the refresh-token cookie is sent and stored. */
  credentials?: 'omit' | 'same-origin' | 'include';
}

/** Any failure to get a valid answer: network, HTTP error (RFC 9457 problem details), or a malformed body. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Stable machine-readable code from the API (see `ErrorCode` in contracts), or a client-side code. */
    readonly code?: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Args<R extends RouteSpec> = keyof RouteInput<R> extends never ? [] : [input: RouteInput<R>];

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function call<R extends RouteSpec>(route: R, ...args: Args<R>): Promise<RouteOutput<R>> {
    const input = (args[0] ?? {}) as {
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: unknown;
    };

    // Validate before sending: a bug in the caller should fail here, not as a round trip.
    const check = (where: string, schema: RouteSpec['body'], value: unknown) => {
      if (!schema) return value;
      const parsed = schema.safeParse(value ?? {});
      if (!parsed.success) {
        throw new ApiError(
          'Invalid request',
          undefined,
          'validation_failed',
          parsed.error.issues.map((i) => ({
            path: [where, ...i.path].join('.'),
            message: i.message,
          })),
        );
      }
      return parsed.data;
    };
    const params = check('params', route.params, input.params) as
      Record<string, unknown> | undefined;
    const query = check('query', route.query, input.query) as Record<string, unknown> | undefined;
    const body = check('body', route.body, input.body);

    const path = route.path.replace(/:(\w+)/g, (_, key: string) =>
      encodeURIComponent(String(params?.[key])),
    );
    const qs = new URLSearchParams(
      Object.entries(query ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();

    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (route.body) headers['content-type'] = 'application/json';
    if (route.auth === 'access') {
      const token = await options.getAccessToken?.();
      if (token) headers.authorization = `Bearer ${token}`;
    }

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}${qs ? `?${qs}` : ''}`, {
        method: route.method,
        headers,
        ...(route.body ? { body: JSON.stringify(body) } : {}),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new ApiError(
        `API unreachable at ${baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
        undefined,
        'network_error',
      );
    }

    const expected = route.status ?? 200;
    // The readiness probe answers 503 with a valid body when a dependency is down; that is data, not a failure.
    const accepted = res.status === expected || (route.id === 'healthReady' && res.status === 503);
    const payload: unknown = await res.json().catch(() => undefined);

    if (!accepted) {
      const problem = Problem.safeParse(payload);
      if (problem.success)
        throw new ApiError(
          problem.data.detail ?? problem.data.title,
          res.status,
          problem.data.code,
          problem.data.errors,
        );
      throw new ApiError(
        `Unexpected status ${res.status} from ${route.path}`,
        res.status,
        'unexpected_response',
      );
    }
    const parsed = route.response.safeParse(payload);
    if (!parsed.success)
      throw new ApiError(
        `Invalid response body from ${route.path}`,
        res.status,
        'invalid_response',
      );
    return parsed.data as RouteOutput<R>;
  }

  return {
    /** Low-level typed call for any route in the registry. */
    call,
    health: {
      live: () => call(routes.healthLive),
      /** A 503 "degraded" answer is returned, not thrown. */
      ready: () => call(routes.healthReady),
    },
    auth: {
      register: (body: RouteInput<typeof routes.register>['body']) =>
        call(routes.register, { body }),
      login: (body: RouteInput<typeof routes.login>['body']) => call(routes.login, { body }),
      refresh: (body: RouteInput<typeof routes.refresh>['body'] = {}) =>
        call(routes.refresh, { body }),
      logout: () => call(routes.logout),
      switchTenant: (tenantId: string) => call(routes.switchTenant, { body: { tenantId } }),
      acceptInvitation: (body: RouteInput<typeof routes.acceptInvitation>['body']) =>
        call(routes.acceptInvitation, { body }),
    },
    me: () => call(routes.me),
    tenant: () => call(routes.tenant),
    members: {
      list: () => call(routes.listMembers),
      invite: (body: RouteInput<typeof routes.inviteMember>['body']) =>
        call(routes.inviteMember, { body }),
      listInvitations: () => call(routes.listInvitations),
      revokeInvitation: (id: string) => call(routes.revokeInvitation, { params: { id } }),
      updateRole: (id: string, role: RouteInput<typeof routes.updateMember>['body']['role']) =>
        call(routes.updateMember, { params: { id }, body: { role } }),
      remove: (id: string) => call(routes.removeMember, { params: { id } }),
    },
    auditLogs: {
      list: (query: RouteInput<typeof routes.listAuditLogs>['query'] = {}) =>
        call(routes.listAuditLogs, { query }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
