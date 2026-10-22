import { randomUUID } from 'node:crypto';
import {
  SecretBox,
  TikTokShopClient,
  type TikTokMetrics,
  type TikTokProcessDeps,
  type TikTokSyncDeps,
  tiktokRequestSignature,
} from '@orderloop/automation';
import { tiktokOrderSink } from '@orderloop/catalog';
import { CredentialVault } from '../src/couriers/credential-vault.js';
import type { TestApp } from './app.js';

export const APP_KEY = '6testappkey';
export const APP_SECRET = 'tiktok-test-app-secret-0123456789';
export const AUTH_HOST = 'https://auth.tiktok-shops.test';
export const API_HOST = 'https://open-api.tiktokglobalshop.test';

/** Buyer details a real TikTok order carries. Nothing of this may ever be stored: the tests search every column for these. */
export const BUYER = {
  name: 'Siti Aminah binti Rahman',
  firstName: 'Siti',
  phone: '+60123456789',
  email: 'siti.aminah@buyer-example.my',
  address: 'No 12, Jalan Bukit Bintang, Kuala Lumpur',
  postal: '55100',
  message: 'Please leave it with the guard Encik Razak',
};
export const BUYER_NEEDLES = [
  'Siti Aminah',
  'binti Rahman',
  '60123456789',
  'buyer-example.my',
  'Jalan Bukit Bintang',
  '55100',
  'Encik Razak',
];

export interface RawLine {
  skuId: string;
  sellerSku?: string | null;
  name?: string;
  price?: string;
  /** TikTok lists one line item per unit. */
  units?: number;
}

/** An order object in the shape TikTok's order APIs return (SDK field names), buyer data included. */
export function rawOrder(over: {
  id: string;
  status?: string;
  updateTime?: number;
  createTime?: number;
  currency?: string;
  onHold?: boolean;
  lines: RawLine[];
}) {
  const currency = over.currency ?? 'MYR';
  const items: Record<string, unknown>[] = [];
  let sub = 0;
  for (const l of over.lines)
    for (let i = 0; i < (l.units ?? 1); i++) {
      items.push({
        id: `${over.id}-${l.skuId}-${i}`,
        sku_id: l.skuId,
        seller_sku: l.sellerSku ?? null,
        product_name: l.name ?? `Product ${l.skuId}`,
        sale_price: l.price ?? '10.00',
        currency,
        display_status: 'AWAITING_SHIPMENT',
      });
      sub += Number(l.price ?? '10.00');
    }
  return {
    id: over.id,
    status: over.status ?? 'AWAITING_SHIPMENT',
    create_time: over.createTime ?? 1_790_000_000,
    update_time: over.updateTime ?? 1_790_000_100,
    is_on_hold_order: over.onHold ?? false,
    fulfillment_type: 'FULFILLED_BY_SELLER',
    payment: {
      currency,
      sub_total: sub.toFixed(2),
      shipping_fee: '2.50',
      seller_discount: '0.00',
      platform_discount: '1.00',
      tax: '0.60',
      total_amount: (sub + 2.5 - 1).toFixed(2),
    },
    line_items: items,
    // everything below is buyer data
    user_id: 'buyer-9999',
    buyer_email: BUYER.email,
    buyer_message: BUYER.message,
    recipient_address: {
      name: BUYER.name,
      first_name: BUYER.firstName,
      phone_number: BUYER.phone,
      full_address: BUYER.address,
      address_detail: BUYER.address,
      postal_code: BUYER.postal,
      region_code: 'MY',
    },
  };
}

export interface FakeShop {
  id: string;
  cipher: string;
  name: string;
  region: string;
  seller_type: string;
}

export interface TikCall {
  host: 'auth' | 'api';
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string | undefined;
}

type Failure = { status?: number; code: number; message?: string };

const SHOP_COUNTER = { n: 0 };
export const newShop = (over: Partial<FakeShop> = {}): FakeShop => {
  SHOP_COUNTER.n += 1;
  const id = over.id ?? `7${Date.now()}${SHOP_COUNTER.n}${Math.floor(Math.random() * 1000)}`;
  return {
    id,
    cipher: over.cipher ?? `ROW_cipher_${id}`,
    name: over.name ?? `Seller Shop ${SHOP_COUNTER.n}`,
    region: over.region ?? 'MY',
    seller_type: over.seller_type ?? 'LOCAL',
  };
};

/**
 * A fake TikTok Shop (the injected `fetch`): nothing real is ever called. It checks what the real one checks, so a mistake in
 * the client shows up as a failing test: the request signature (recomputed from the URL, the sorted query and the body), the
 * `x-tts-access-token` header, the app secret and the auth code, and that a refresh token works ONCE (it rotates on every refresh).
 * Every request is recorded in `calls`, so a test can assert what was sent and where the tokens travelled.
 */
export function fakeTikTok(
  opts: { appKey?: string; appSecret?: string; now?: () => Date; accessLifetimeSec?: number } = {},
) {
  const appKey = opts.appKey ?? APP_KEY;
  const appSecret = opts.appSecret ?? APP_SECRET;
  const clock = opts.now ?? (() => new Date());
  const lifetime = opts.accessLifetimeSec ?? 86_400;
  const g = {
    calls: [] as TikCall[],
    goodCode: 'GOOD_AUTH_CODE',
    shops: [] as FakeShop[],
    /** The token pair currently valid. A refresh replaces it, and the old refresh token stops working. */
    access: `ROW_access_${randomUUID().replaceAll('-', '')}`,
    refresh: `ROW_refresh_${randomUUID().replaceAll('-', '')}`,
    refreshes: 0,
    /** What `access_token_expire_in` carries: an absolute timestamp, or seconds (set `expiresAsDuration`). */
    expiresAsDuration: false,
    accessExpiresAt: new Date(clock().getTime() + lifetime * 1000),
    refreshExpiresAt: new Date(clock().getTime() + 30 * 86_400_000),
    orders: new Map<string, ReturnType<typeof rawOrder>>(),
    /** When true, a search answers ids only (no line_items), so the client must read the orders in full. */
    searchIdsOnly: false,
    pageSize: 50,
    /** Fail the next calls of a step: token | refresh | shops | search | orders | webhook */
    fail: {} as Record<string, Failure | undefined>,
    /** Make the order search answer 429 this many times, then work. */
    rateLimitSearch: 0,
    /** Slow every call down (for concurrency tests). */
    delayMs: 0,
    issueTokens() {
      const now = clock();
      g.access = `ROW_access_${randomUUID().replaceAll('-', '')}`;
      g.refresh = `ROW_refresh_${randomUUID().replaceAll('-', '')}`;
      g.accessExpiresAt = new Date(now.getTime() + lifetime * 1000);
      g.refreshExpiresAt = new Date(now.getTime() + 30 * 86_400_000);
      return {
        access_token: g.access,
        refresh_token: g.refresh,
        access_token_expire_in: g.expiresAsDuration
          ? lifetime
          : Math.floor(g.accessExpiresAt.getTime() / 1000),
        refresh_token_expire_in: g.expiresAsDuration
          ? 30 * 86_400
          : Math.floor(g.refreshExpiresAt.getTime() / 1000),
        open_id: 'open-1',
        seller_name: 'Seller',
        granted_scopes: ['seller.order.info', 'seller.authorization.info'],
      };
    },
    fetch: (async (
      url: string,
      init: { method?: string; body?: string; headers?: Record<string, string> } = {},
    ) => {
      if (g.delayMs) await new Promise((r) => setTimeout(r, g.delayMs));
      const u = new URL(url);
      const call: TikCall = {
        host: u.origin === AUTH_HOST ? 'auth' : 'api',
        method: init.method ?? 'GET',
        path: u.pathname,
        query: u.searchParams,
        headers: Object.fromEntries(
          Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
        ),
        body: init.body,
      };
      g.calls.push(call);
      const ok = (data: unknown) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ code: 0, message: 'Success', request_id: 'r1', data }),
        }) as Response;
      const err = (f: Failure) =>
        ({
          ok: (f.status ?? 200) < 400,
          status: f.status ?? 200,
          json: async () => ({
            code: f.code,
            message: f.message ?? 'tiktok says no',
            request_id: 'r2',
          }),
        }) as Response;
      const q = (k: string) => call.query.get(k);

      if (call.host === 'auth') {
        if (q('app_key') !== appKey || q('app_secret') !== appSecret)
          return err({ status: 200, code: 36004004, message: 'invalid app credentials' });
        if (call.path === '/api/v2/token/get') {
          const f = g.fail['token'];
          if (f) return err(f);
          if (q('grant_type') !== 'authorized_code' || q('auth_code') !== g.goodCode)
            return err({ status: 200, code: 36004002, message: 'invalid auth_code' });
          return ok(g.issueTokens());
        }
        if (call.path === '/api/v2/token/refresh') {
          g.refreshes += 1;
          const f = g.fail['refresh'];
          if (f) return err(f);
          if (q('grant_type') !== 'refresh_token' || q('refresh_token') !== g.refresh)
            return err({
              status: 200,
              code: 36004003,
              message: 'refresh token invalid or expired',
            });
          return ok(g.issueTokens());
        }
        return err({ status: 404, code: 404, message: 'not found' });
      }

      // ---- the shop API: signature, token, then the route --------------------------------------------------------------
      const queryObject = Object.fromEntries(call.query.entries());
      const expected = tiktokRequestSignature({
        path: call.path,
        query: queryObject,
        body: call.method === 'GET' ? '' : (call.body ?? ''),
        appSecret,
      });
      if (q('sign') !== expected || q('app_key') !== appKey || !q('timestamp'))
        return err({ status: 401, code: 105001, message: 'invalid signature' });
      if (call.headers['x-tts-access-token'] !== g.access)
        return err({ status: 401, code: 105002, message: 'access token invalid or expired' });
      const step = call.path.endsWith('/orders/search')
        ? 'search'
        : call.path.includes('/authorization/')
          ? 'shops'
          : call.path.includes('/webhooks')
            ? 'webhook'
            : 'orders';
      const f = g.fail[step];
      if (f) return err(f);

      if (step === 'shops') return ok({ shops: g.shops });
      if (step === 'webhook') return ok({});
      const cipher = q('shop_cipher');
      if (!g.shops.some((s) => s.cipher === cipher))
        return err({ status: 403, code: 105005, message: 'shop cipher not authorized' });
      if (step === 'search') {
        if (g.rateLimitSearch > 0) {
          g.rateLimitSearch -= 1;
          return err({ status: 429, code: 429, message: 'too many requests' });
        }
        const b = JSON.parse(call.body ?? '{}') as {
          update_time_ge?: number;
          update_time_lt?: number;
        };
        const hits = [...g.orders.values()]
          .filter(
            (o) =>
              o.update_time >= (b.update_time_ge ?? 0) &&
              o.update_time < (b.update_time_lt ?? Infinity),
          )
          .sort((a, c) => a.update_time - c.update_time || a.id.localeCompare(c.id));
        const start = Number(q('page_token') ?? 0);
        const size = Math.min(Number(q('page_size') ?? 50), g.pageSize);
        const page = hits.slice(start, start + size);
        return ok({
          orders: g.searchIdsOnly
            ? page.map((o) => ({ id: o.id, status: o.status, update_time: o.update_time }))
            : page,
          next_page_token: start + size < hits.length ? String(start + size) : '',
          total_count: hits.length,
        });
      }
      const ids = (q('ids') ?? '').split(',').filter(Boolean);
      return ok({ orders: ids.map((id) => g.orders.get(id)).filter(Boolean) });
    }) as unknown as typeof fetch,
    called: (path: string) => g.calls.filter((c) => c.path === path || c.path.endsWith(path)),
    /** Every URL and body the fake saw, as one string: tokens must never be somewhere they should not be. */
    wire: () => JSON.stringify(g.calls),
  };
  return g;
}
export type FakeTikTok = ReturnType<typeof fakeTikTok>;

// ---- wiring the shared worker-side code to the test app and the fake TikTok ----------------------------------------------------

/** Counts what the shared code reports, so a test can assert on outcomes without Prometheus. */
export function countingMetrics() {
  const counts = {
    event: {} as Record<string, number>,
    refresh: {} as Record<string, number>,
    reconcile: {} as Record<string, number>,
  };
  const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
  const metrics: TikTokMetrics = {
    event: (r) => bump(counts.event, r),
    refresh: (r) => bump(counts.refresh, r),
    reconcile: (r) => bump(counts.reconcile, r),
  };
  return { counts, metrics };
}

/**
 * The dependencies the worker builds, pointed at the fake TikTok and the test app's database and vault: the real client (real
 * signing), the real sealed-token code, the real catalog sink.
 */
export function workerDeps(
  t: TestApp,
  fake: FakeTikTok,
  opts: { now?: () => Date; metrics?: TikTokMetrics; sleeps?: number[]; apiHost?: string } = {},
) {
  const now = opts.now ?? (() => new Date());
  const vault: SecretBox = t.app.get(CredentialVault, { strict: false });
  const client = new TikTokShopClient({
    fetch: fake.fetch,
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    authHost: AUTH_HOST,
    apiHost: opts.apiHost ?? API_HOST,
    version: '202309',
    now,
  });
  const log: TikTokProcessDeps['log'] = () => undefined;
  const process: TikTokProcessDeps = {
    db: t.db,
    log,
    now,
    sink: tiktokOrderSink,
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
    live: { client, vault },
  };
  const sync: TikTokSyncDeps = {
    db: t.db,
    log,
    now,
    client,
    vault,
    sink: tiktokOrderSink,
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
    sleep: async (ms) => {
      opts.sleeps?.push(ms);
    },
  };
  return { process, sync, client, vault, now };
}
