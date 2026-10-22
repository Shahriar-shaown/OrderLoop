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
  /** How long a read may take. Default 10 s. */
  timeoutMs?: number;
  /** How long a write may take. Default 30 s: the server often finishes a slow booking or import after the wait ends. */
  writeTimeoutMs?: number;
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

const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;

export const isWrite = (method: string): boolean =>
  !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

/** The default time to wait for a request, by method. Also used by wrappers that replay a request. */
export const defaultTimeoutMs = (method: string): number =>
  isWrite(method) ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;

/** For a write that carried an `idempotencyKey`: sending it again with the same key cannot make a second one. */
export const WRITE_TIMEOUT_SAFE_MESSAGE =
  'The server did not answer in time. It is safe to try again.';
export const WRITE_TIMEOUT_MESSAGE =
  'The server did not answer in time. The request may have been received: check before trying again.';

const hasIdempotencyKey = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && 'idempotencyKey' in body && !!body.idempotencyKey;

type Args<R extends RouteSpec> = keyof RouteInput<R> extends never ? [] : [input: RouteInput<R>];

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = (method: string) =>
    (isWrite(method) ? options.writeTimeoutMs : options.timeoutMs) ?? defaultTimeoutMs(method);

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

    const path = route.path.replace(/:(\w+)/g, (_, key: string) => {
      const value = params?.[key];
      if (value === undefined || value === null || value === '')
        throw new ApiError(
          `Missing path parameter "${key}" for ${route.path}`,
          undefined,
          'validation_failed',
        );
      return encodeURIComponent(String(value));
    });
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
        signal: AbortSignal.timeout(timeoutMs(route.method)),
      });
    } catch (cause) {
      // A wrapper around fetch may refuse a request on purpose (the offline guard): that error is already the right one.
      if (cause instanceof ApiError) throw cause;
      // A write that timed out may still have been carried out: a different message, so nobody sends it again blindly.
      if (isWrite(route.method) && cause instanceof Error && cause.name === 'TimeoutError')
        throw new ApiError(
          hasIdempotencyKey(body) ? WRITE_TIMEOUT_SAFE_MESSAGE : WRITE_TIMEOUT_MESSAGE,
          undefined,
          'request_timeout',
        );
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
    /** Delete the signed-in person's own account (password and the word DELETE asked). Ends this session too. */
    deleteAccount: (body: RouteInput<typeof routes.deleteAccount>['body']) =>
      call(routes.deleteAccount, { body }),
    /** Deleting the current business: status (any member), request (owner: name and password), cancel (owner, within the grace period). */
    tenantDeletion: {
      status: () => call(routes.tenantDeletionStatus),
      request: (body: RouteInput<typeof routes.requestTenantDeletion>['body']) =>
        call(routes.requestTenantDeletion, { body }),
      cancel: () => call(routes.cancelTenantDeletion),
    },
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
      create: (name: string, idempotencyKey?: string) =>
        call(routes.createCategory, { body: { name, idempotencyKey } }),
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
      summary: () => call(routes.getInventorySummary),
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
      customers: () => call(routes.exportCustomers),
      orders: (filters: RouteInput<typeof routes.exportOrders>['query'] = {}) =>
        call(routes.exportOrders, { query: filters }),
    },
    dashboard: {
      get: (period: RouteInput<typeof routes.getDashboard>['query']['period'] = '7d') =>
        call(routes.getDashboard, { query: { period } }),
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
      /** Irreversible: removes the customer's personal data here and on their orders. 409 `erase_blocked` while an order is in progress. */
      erase: (id: string, body: RouteInput<typeof routes.eraseCustomer>['body']) =>
        call(routes.eraseCustomer, { params: { id }, body }),
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
    couriers: {
      list: () => call(routes.listCouriers),
      /** Credentials are write-only: they are sent once, stored encrypted on the server, and never come back. */
      save: (
        provider: RouteInput<typeof routes.saveCourier>['params']['provider'],
        body: RouteInput<typeof routes.saveCourier>['body'],
      ) => call(routes.saveCourier, { params: { provider }, body }),
      remove: (provider: RouteInput<typeof routes.removeCourier>['params']['provider']) =>
        call(routes.removeCourier, { params: { provider } }),
      test: (provider: RouteInput<typeof routes.testCourier>['params']['provider']) =>
        call(routes.testCourier, { params: { provider } }),
      locations: (
        provider: RouteInput<typeof routes.listCourierLocations>['params']['provider'],
        query: RouteInput<typeof routes.listCourierLocations>['query'],
      ) => call(routes.listCourierLocations, { params: { provider }, query }),
    },
    shipments: {
      /** Every shipment, newest first, with a count per status for the same search. */
      list: (query: RouteInput<typeof routes.listShipments>['query'] = {}) =>
        call(routes.listShipments, { query }),
      /** Courier KPIs and per-courier results. */
      stats: () => call(routes.getShipmentSummary),
      quote: (orderId: string, body: RouteInput<typeof routes.quoteShipping>['body']) =>
        call(routes.quoteShipping, { params: { id: orderId }, body }),
      /** `idempotencyKey` is required: repeat the same key to retry safely; a new key means a new booking. */
      book: (orderId: string, body: RouteInput<typeof routes.bookShipment>['body']) =>
        call(routes.bookShipment, { params: { id: orderId }, body }),
      forOrder: (orderId: string) => call(routes.listOrderShipments, { params: { id: orderId } }),
      get: (id: string) => call(routes.getShipment, { params: { id } }),
      refresh: (id: string) => call(routes.refreshShipment, { params: { id } }),
      cancel: (id: string, body: RouteInput<typeof routes.cancelShipment>['body']) =>
        call(routes.cancelShipment, { params: { id }, body }),
      resolve: (id: string, body: RouteInput<typeof routes.resolveShipment>['body']) =>
        call(routes.resolveShipment, { params: { id }, body }),
      simulate: (id: string, body: RouteInput<typeof routes.simulateShipmentEvent>['body']) =>
        call(routes.simulateShipmentEvent, { params: { id }, body }),
    },
    finance: {
      orderCash: (orderId: string) => call(routes.getOrderCash, { params: { id: orderId } }),
      analytics: (query: RouteInput<typeof routes.getAnalytics>['query'] = {}) =>
        call(routes.getAnalytics, { query }),
      /** The same file is never imported twice. `dryRun` checks it and shows what would happen without recording anything. */
      importSettlement: (body: RouteInput<typeof routes.importSettlement>['body']) =>
        call(routes.importSettlement, { body }),
      batches: (query: RouteInput<typeof routes.listSettlementBatches>['query'] = {}) =>
        call(routes.listSettlementBatches, { query }),
      batch: (id: string) => call(routes.getSettlementBatch, { params: { id } }),
      reconcile: (id: string) => call(routes.reconcileSettlementBatch, { params: { id } }),
      unmatched: () => call(routes.listUnmatchedSettlementItems),
      item: (id: string) => call(routes.getSettlementItem, { params: { id } }),
      matchItem: (id: string, body: RouteInput<typeof routes.matchSettlementItem>['body']) =>
        call(routes.matchSettlementItem, { params: { id }, body }),
      unmatchItem: (id: string, reason: string) =>
        call(routes.unmatchSettlementItem, { params: { id }, body: { reason } }),
      ignoreItem: (id: string, reason: string) =>
        call(routes.ignoreSettlementItem, { params: { id }, body: { reason } }),
      discrepancies: (query: RouteInput<typeof routes.listDiscrepancies>['query'] = {}) =>
        call(routes.listDiscrepancies, { query }),
      resolveDiscrepancy: (
        id: string,
        body: RouteInput<typeof routes.resolveDiscrepancy>['body'],
      ) => call(routes.resolveDiscrepancy, { params: { id }, body }),
      recheck: () => call(routes.recheckFinance),
      outstanding: () => call(routes.getOutstandingCod),
      summary: (query: RouteInput<typeof routes.getFinanceSummary>['query'] = {}) =>
        call(routes.getFinanceSummary, { query }),
      costs: (query: RouteInput<typeof routes.listCosts>['query'] = {}) =>
        call(routes.listCosts, { query }),
      createCost: (body: RouteInput<typeof routes.createCost>['body']) =>
        call(routes.createCost, { body }),
      voidCost: (id: string, reason: string) =>
        call(routes.voidCost, { params: { id }, body: { reason } }),
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
      products: (csv: string, idempotencyKey?: string) =>
        call(routes.importProducts, { body: { csv, idempotencyKey } }),
      /** What the import would do, without changing anything. */
      validateProducts: (csv: string) => call(routes.validateProductImport, { body: { csv } }),
      get: (id: string) => call(routes.getImport, { params: { id } }),
      list: () => call(routes.listImports),
    },
    /** Rules, their runs and deliveries (`automation:read` to look, `automation:manage` to change). */
    automation: {
      rules: () => call(routes.listAutomationRules),
      /** Replaces the rule's settings: only what is sent is changed (`channels` is partial, `config` is whole). */
      updateRule: (
        kind: RouteInput<typeof routes.updateAutomationRule>['params']['kind'],
        body: RouteInput<typeof routes.updateAutomationRule>['body'],
      ) => call(routes.updateAutomationRule, { params: { kind }, body }),
      /** Evaluate now. The same `idempotencyKey` again returns the first run instead of starting another. */
      runRule: (
        kind: RouteInput<typeof routes.runAutomationRule>['params']['kind'],
        idempotencyKey?: string,
      ) => call(routes.runAutomationRule, { params: { kind }, body: { idempotencyKey } }),
      runs: (query: RouteInput<typeof routes.listAutomationRuns>['query'] = {}) =>
        call(routes.listAutomationRuns, { query }),
      retryRun: (id: string) => call(routes.retryAutomationRun, { params: { id } }),
      deliveries: (query: RouteInput<typeof routes.listAutomationDeliveries>['query'] = {}) =>
        call(routes.listAutomationDeliveries, { query }),
      retryDelivery: (id: string) => call(routes.retryAutomationDelivery, { params: { id } }),
    },
    /**
     * Facebook Page and Instagram messages (`integrations:read` to look, `integrations:manage` to change). Receive-only: there is
     * no call that sends a message. The mock calls exist only in mock mode and are 404 in live mode.
     */
    meta: {
      overview: () => call(routes.getMetaOverview),
      /** Live: returns the Meta sign-in address to send the browser to. 409 `meta_not_configured` in mock mode. */
      startOauth: () => call(routes.startMetaOauth, { body: {} }),
      session: (id: string) => call(routes.getMetaOauthSession, { params: { id } }),
      connect: (body: RouteInput<typeof routes.connectMetaPages>['body']) =>
        call(routes.connectMetaPages, { body }),
      /** Disconnecting twice is not an error. */
      disconnect: (id: string) => call(routes.disconnectMetaConnection, { params: { id } }),
      reconnect: (id: string) => call(routes.reconnectMetaConnection, { params: { id } }),
      mockConnection: (body: RouteInput<typeof routes.createMockMetaConnection>['body'] = {}) =>
        call(routes.createMockMetaConnection, { body }),
      /** Repeating a `messageId` (or the same text from the same sender) creates nothing new. */
      mockEvent: (body: RouteInput<typeof routes.injectMockMetaEvent>['body']) =>
        call(routes.injectMockMetaEvent, { body }),
    },
    /**
     * TikTok Shop (`integrations:read` to look, `integrations:manage` to change): a READ-ONLY mirror of a shop's orders in the
     * shop's own currency (never BDT, no buyer data) that keeps stock honest. There is no call that changes anything at TikTok. The
     * mock calls exist only in mock mode and are 404 in live mode.
     */
    tiktokShop: {
      overview: () => call(routes.getTikTokOverview),
      /** Live: returns the TikTok sign-in address to send the browser to. 409 `tiktok_not_configured` in mock mode. */
      startOauth: () => call(routes.startTikTokOauth, { body: {} }),
      session: (id: string) => call(routes.getTikTokOauthSession, { params: { id } }),
      connect: (body: RouteInput<typeof routes.connectTikTokShops>['body']) =>
        call(routes.connectTikTokShops, { body }),
      /** Disconnecting twice is not an error. */
      disconnect: (id: string) => call(routes.disconnectTikTokConnection, { params: { id } }),
      reconnect: (id: string) => call(routes.reconnectTikTokConnection, { params: { id } }),
      /** Look at TikTok now (live) and at the orders waiting for a SKU link or for stock. */
      sync: (id: string) => call(routes.syncTikTokConnection, { params: { id } }),
      mockConnection: (body: RouteInput<typeof routes.createMockTikTokConnection>['body'] = {}) =>
        call(routes.createMockTikTokConnection, { body }),
      /** Repeating an `externalOrderId` with the same `notificationId` creates nothing new. */
      mockOrder: (body: RouteInput<typeof routes.injectMockTikTokOrder>['body']) =>
        call(routes.injectMockTikTokOrder, { body }),
      mockStatus: (
        id: string,
        body: RouteInput<typeof routes.changeMockTikTokOrderStatus>['body'],
      ) => call(routes.changeMockTikTokOrderStatus, { params: { id }, body }),
    },
    /** Orders mirrored from TikTok Shop (`orders:read`). Read-only. */
    tiktokOrders: {
      list: (query: RouteInput<typeof routes.listTikTokOrders>['query'] = {}) =>
        call(routes.listTikTokOrders, { query }),
      get: (id: string) => call(routes.getTikTokOrder, { params: { id } }),
    },
    /** TikTok SKU to OrderLoop variant links (`inventory:read` to look, `inventory:write` to map). */
    tiktokSkuLinks: {
      list: (query: RouteInput<typeof routes.listTikTokSkuLinks>['query'] = {}) =>
        call(routes.listTikTokSkuLinks, { query }),
      /** `variantId: null` clears the link. Orders waiting for it are looked at again at once. */
      update: (id: string, variantId: string | null) =>
        call(routes.updateTikTokSkuLink, { params: { id }, body: { variantId } }),
    },
    /** Draft orders made from customer messages (`orders:read` to look, `orders:write` to change). */
    socialDrafts: {
      list: (query: RouteInput<typeof routes.listSocialDrafts>['query'] = {}) =>
        call(routes.listSocialDrafts, { query }),
      get: (id: string) => call(routes.getSocialDraft, { params: { id } }),
      /** Edits survive new messages; `null` removes an edit. 409 `draft_closed` once confirmed or dismissed. */
      update: (id: string, body: RouteInput<typeof routes.updateSocialDraft>['body']) =>
        call(routes.updateSocialDraft, { params: { id }, body }),
      /** The same body as creating an order. Reuse its `idempotencyKey` on retry: confirming twice returns the same order. */
      confirm: (id: string, body: RouteInput<typeof routes.confirmSocialDraft>['body']) =>
        call(routes.confirmSocialDraft, { params: { id }, body }),
      dismiss: (id: string, reason?: string) =>
        call(routes.dismissSocialDraft, { params: { id }, body: { reason } }),
    },
    /** The signed-in person's own notifications, channel choices, phones and messaging consent. */
    notifications: {
      list: (query: RouteInput<typeof routes.listNotifications>['query'] = {}) =>
        call(routes.listNotifications, { query }),
      unreadCount: () => call(routes.getUnreadNotificationCount),
      /** Returns the notification, so a tapped push can open the right screen from one call. */
      markRead: (id: string) => call(routes.markNotificationRead, { params: { id } }),
      markAllRead: () => call(routes.markAllNotificationsRead),
      preferences: () => call(routes.getNotificationPreferences),
      updatePreferences: (
        items: RouteInput<typeof routes.updateNotificationPreferences>['body']['items'],
      ) => call(routes.updateNotificationPreferences, { body: { items } }),
    },
    pushDevices: {
      /** An upsert by token: calling it again only refreshes the device. */
      register: (body: RouteInput<typeof routes.registerPushDevice>['body']) =>
        call(routes.registerPushDevice, { body }),
      /** Forgetting a token that is not there is not an error. */
      remove: (token: string) => call(routes.removePushDevice, { params: { token } }),
    },
    messagingConsents: {
      get: () => call(routes.getMessagingConsents),
      update: (body: RouteInput<typeof routes.updateMessagingConsent>['body']) =>
        call(routes.updateMessagingConsent, { body }),
    },
    auditLogs: {
      list: (query: RouteInput<typeof routes.listAuditLogs>['query'] = {}) =>
        call(routes.listAuditLogs, { query }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
