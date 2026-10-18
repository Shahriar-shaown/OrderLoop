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
      verifyEmail: (token: string) => call(routes.verifyEmail, { body: { token } }),
      resendVerification: () => call(routes.resendVerification),
      /** Always resolves, whether or not the address has an account. */
      forgotPassword: (email: string) => call(routes.forgotPassword, { body: { email } }),
      resetPassword: (token: string, password: string) =>
        call(routes.resetPassword, { body: { token, password } }),
      switchTenant: (tenantId: string) => call(routes.switchTenant, { body: { tenantId } }),
      acceptInvitation: (body: RouteInput<typeof routes.acceptInvitation>['body']) =>
        call(routes.acceptInvitation, { body }),
    },
    me: () => call(routes.me),
    updatePreferences: (
      language: RouteInput<typeof routes.updatePreferences>['body']['language'],
    ) => call(routes.updatePreferences, { body: { language } }),
    tenant: () => call(routes.tenant),
    updateTenant: (body: RouteInput<typeof routes.updateTenant>['body']) =>
      call(routes.updateTenant, { body }),
    workspaces: {
      list: () => call(routes.listWorkspaces),
      create: (body: RouteInput<typeof routes.createWorkspace>['body']) =>
        call(routes.createWorkspace, { body }),
    },
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
    categories: {
      list: () => call(routes.listCategories),
      create: (name: string) => call(routes.createCategory, { body: { name } }),
      rename: (id: string, name: string) =>
        call(routes.updateCategory, { params: { id }, body: { name } }),
      remove: (id: string) => call(routes.deleteCategory, { params: { id } }),
    },
    products: {
      list: (query: RouteInput<typeof routes.listProducts>['query'] = {}) =>
        call(routes.listProducts, { query }),
      get: (id: string) => call(routes.getProduct, { params: { id } }),
      create: (body: RouteInput<typeof routes.createProduct>['body']) =>
        call(routes.createProduct, { body }),
      update: (id: string, body: RouteInput<typeof routes.updateProduct>['body']) =>
        call(routes.updateProduct, { params: { id }, body }),
      addVariant: (id: string, body: RouteInput<typeof routes.addVariant>['body']) =>
        call(routes.addVariant, { params: { id }, body }),
      updateVariant: (id: string, body: RouteInput<typeof routes.updateVariant>['body']) =>
        call(routes.updateVariant, { params: { id }, body }),
    },
    locations: {
      list: () => call(routes.listLocations),
      create: (body: RouteInput<typeof routes.createLocation>['body']) =>
        call(routes.createLocation, { body }),
      update: (id: string, body: RouteInput<typeof routes.updateLocation>['body']) =>
        call(routes.updateLocation, { params: { id }, body }),
    },
    suppliers: {
      list: () => call(routes.listSuppliers),
      create: (body: RouteInput<typeof routes.createSupplier>['body']) =>
        call(routes.createSupplier, { body }),
      update: (id: string, body: RouteInput<typeof routes.updateSupplier>['body']) =>
        call(routes.updateSupplier, { params: { id }, body }),
    },
    inventory: {
      list: (query: RouteInput<typeof routes.listInventory>['query'] = {}) =>
        call(routes.listInventory, { query }),
      receive: (body: RouteInput<typeof routes.receiveStock>['body']) =>
        call(routes.receiveStock, { body }),
      adjust: (body: RouteInput<typeof routes.adjustStock>['body']) =>
        call(routes.adjustStock, { body }),
      movements: (query: RouteInput<typeof routes.listMovements>['query'] = {}) =>
        call(routes.listMovements, { query }),
      damage: (body: RouteInput<typeof routes.damageStock>['body']) =>
        call(routes.damageStock, { body }),
      writeOff: (body: RouteInput<typeof routes.writeOffStock>['body']) =>
        call(routes.writeOffStock, { body }),
      /** For the returns workflow: `idempotencyKey` makes processing the same return twice add the units once. */
      return: (body: RouteInput<typeof routes.returnStock>['body']) =>
        call(routes.returnStock, { body }),
      lowStock: () => call(routes.lowStock),
    },
    exports: {
      products: () => call(routes.exportProducts),
      stock: () => call(routes.exportStock),
      orders: (filters: RouteInput<typeof routes.exportOrders>['query'] = {}) =>
        call(routes.exportOrders, { query: filters }),
    },
    customers: {
      list: (query: RouteInput<typeof routes.listCustomers>['query'] = {}) =>
        call(routes.listCustomers, { query }),
      get: (id: string) => call(routes.getCustomer, { params: { id } }),
      create: (body: RouteInput<typeof routes.createCustomer>['body']) =>
        call(routes.createCustomer, { body }),
      update: (id: string, body: RouteInput<typeof routes.updateCustomer>['body']) =>
        call(routes.updateCustomer, { params: { id }, body }),
      addAddress: (id: string, body: RouteInput<typeof routes.addCustomerAddress>['body']) =>
        call(routes.addCustomerAddress, { params: { id }, body }),
      updateAddress: (
        id: string,
        addressId: string,
        body: RouteInput<typeof routes.updateCustomerAddress>['body'],
      ) => call(routes.updateCustomerAddress, { params: { id, addressId }, body }),
      removeAddress: (id: string, addressId: string) =>
        call(routes.deleteCustomerAddress, { params: { id, addressId } }),
      orders: (id: string, query: RouteInput<typeof routes.listCustomerOrders>['query'] = {}) =>
        call(routes.listCustomerOrders, { params: { id }, query }),
    },
    orders: {
      list: (query: RouteInput<typeof routes.listOrders>['query'] = {}) =>
        call(routes.listOrders, { query }),
      get: (id: string) => call(routes.getOrder, { params: { id } }),
      /** `idempotencyKey` is required: a retry with the same key returns the order already made. */
      create: (body: RouteInput<typeof routes.createOrder>['body']) =>
        call(routes.createOrder, { body }),
      update: (id: string, body: RouteInput<typeof routes.updateOrder>['body']) =>
        call(routes.updateOrder, { params: { id }, body }),
      changeStatus: (id: string, body: RouteInput<typeof routes.changeOrderStatus>['body']) =>
        call(routes.changeOrderStatus, { params: { id }, body }),
      bulkChangeStatus: (body: RouteInput<typeof routes.bulkChangeOrderStatus>['body']) =>
        call(routes.bulkChangeOrderStatus, { body }),
      duplicates: (id: string) => call(routes.listOrderDuplicates, { params: { id } }),
      checkDuplicates: (body: RouteInput<typeof routes.checkOrderDuplicates>['body']) =>
        call(routes.checkOrderDuplicates, { body }),
      validateImport: (csv: string) => call(routes.validateOrderImport, { body: { csv } }),
      import: (csv: string) => call(routes.importOrders, { body: { csv } }),
    },
    reservations: {
      list: (query: RouteInput<typeof routes.listReservations>['query'] = {}) =>
        call(routes.listReservations, { query }),
      create: (body: RouteInput<typeof routes.createReservation>['body']) =>
        call(routes.createReservation, { body }),
      release: (id: string) => call(routes.releaseReservation, { params: { id } }),
      fulfil: (id: string) => call(routes.fulfilReservation, { params: { id } }),
    },
    imports: {
      /** Starts a background import and returns at once; poll `get` until the status is COMPLETED or FAILED. */
      products: (csv: string) => call(routes.importProducts, { body: { csv } }),
      /** What the import would do, without changing anything. */
      validateProducts: (csv: string) => call(routes.validateProductImport, { body: { csv } }),
      get: (id: string) => call(routes.getImport, { params: { id } }),
      list: () => call(routes.listImports),
    },
    auditLogs: {
      list: (query: RouteInput<typeof routes.listAuditLogs>['query'] = {}) =>
        call(routes.listAuditLogs, { query }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
