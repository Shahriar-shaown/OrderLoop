import type {
  TikTokConnection,
  TikTokConnectionStatus,
  TikTokOrder,
  TikTokOrderSummary,
  TikTokStockState,
} from '@orderloop/contracts';
import type { Tone } from '@orderloop/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../core/auth';
import { useCan } from '../core/permissions';
import { useApi } from '../core/runtime';
import { invalidateKeys } from './invalidate';

export const TIKTOK_PATH = '/settings/integrations/tiktok-shop';
export const META_PATH = '/settings/integrations/meta';

/** The notice every mock TikTok screen carries. It is worded once so every screen says the same thing. */
export const MOCK_NOTICE_TITLE = 'Mock integration: not connected to TikTok';
export const MOCK_NOTICE_TEXT =
  'Shops and orders here are simulated for testing. Nothing is sent to or received from TikTok Shop.';

/** What OrderLoop does and does not do with TikTok Shop. Said on the integration page and on the orders. */
export const READ_ONLY_TEXT =
  'OrderLoop only reads TikTok Shop to keep your stock honest. It never changes anything on TikTok: no orders, no products, no stock.';
export const NOT_TESTED_TEXT =
  'This connection has not been tested with TikTok yet. Check every figure against your TikTok Seller Center until it has been.';
export const CURRENCY_TEXT =
  'Amounts are in the shop’s own currency, not taka. They are never added to your taka totals, revenue or profit.';
export const NO_BUYER_TEXT = 'OrderLoop does not store any buyer details from TikTok.';

// ---- connections -------------------------------------------------------------------------------------------------------

export const CONNECTION_STATUS: Record<
  TikTokConnectionStatus,
  { label: string; tone: Tone; explanation: string }
> = {
  active: {
    label: 'Active',
    tone: 'success',
    explanation: 'Orders from this shop reach OrderLoop and keep your stock up to date.',
  },
  needs_reconnect: {
    label: 'Needs reconnecting',
    tone: 'warning',
    explanation:
      'TikTok no longer accepts the saved access, for example because it expired or the app was removed. New orders are not arriving until you reconnect.',
  },
  permission_error: {
    label: 'Permission missing',
    tone: 'warning',
    explanation:
      'A permission was removed or was not approved. Orders may not arrive until you reconnect and approve every permission.',
  },
  disconnected: {
    label: 'Disconnected',
    tone: 'neutral',
    explanation: 'This shop is not sending orders. Connect it again to start.',
  },
};
/** A status this app does not know yet is shown as it came, neutral. */
export const connectionStatus = (status: string) =>
  (CONNECTION_STATUS as Record<string, (typeof CONNECTION_STATUS)[TikTokConnectionStatus]>)[
    status
  ] ?? {
    label: humanize(status),
    tone: 'neutral' as Tone,
    explanation: 'OrderLoop does not know this status yet.',
  };

/** What the short error code on a connection means, in plain words. */
export const ERROR_CODE_TEXT: Record<string, string> = {
  token_invalid: 'TikTok did not accept the saved access.',
  permission_denied: 'TikTok says a permission is missing.',
  deauthorized: 'The seller removed OrderLoop from this shop in TikTok.',
};
export const errorCodeText = (code: string): string =>
  ERROR_CODE_TEXT[code] ?? 'TikTok reported a problem with this shop.';

/** Why a sign-in with TikTok did not work (the `?error=` code OrderLoop is sent back with). */
export const OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'The sign-in with TikTok was cancelled or refused, so nothing was connected.',
  invalid_state:
    'The sign-in link expired or was already used. Start the connection again from this page.',
  tiktok_not_configured:
    'Connecting to TikTok Shop is not set up on this server yet. Ask whoever runs the server to set it up.',
  tiktok_permission_denied:
    'TikTok did not give OrderLoop every permission it needs. Try again and approve every permission.',
  tiktok_token_invalid: 'TikTok did not accept the sign-in. Try connecting again.',
  tiktok_unavailable: 'TikTok could not be reached right now. Try again in a few minutes.',
  rate_limited: 'TikTok is asking us to slow down. Wait a few minutes and try again.',
};
export const oauthErrorMessage = (code: string): string =>
  OAUTH_ERRORS[code] ?? 'The sign-in with TikTok did not finish. Try connecting again.';

/** TikTok's seller type and fulfilment type as words: the known ones are translated, others are shown as they came. */
const TYPE_WORDS: Record<string, string> = {
  LOCAL: 'Local',
  CROSS_BORDER: 'Cross-border',
  FULFILLED_BY_SELLER: 'Fulfilled by seller',
  FULFILLED_BY_TIKTOK: 'Fulfilled by TikTok',
  FULFILLED_BY_PLATFORM: 'Fulfilled by TikTok',
};
export const typeText = (raw: string): string => TYPE_WORDS[raw] ?? humanize(raw);

// ---- orders ------------------------------------------------------------------------------------------------------------

/** "SOME_NEW_STATUS" as "Some new status": for a value this app has no wording for. */
export function humanize(raw: string): string {
  const words = raw.trim().replace(/[_-]+/g, ' ').toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
}

export const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  UNPAID: { label: 'Unpaid', tone: 'neutral' },
  ON_HOLD: { label: 'On hold', tone: 'neutral' },
  AWAITING_SHIPMENT: { label: 'Awaiting shipment', tone: 'info' },
  PARTIALLY_SHIPPING: { label: 'Partly shipping', tone: 'info' },
  AWAITING_COLLECTION: { label: 'Awaiting collection', tone: 'info' },
  IN_TRANSIT: { label: 'In transit', tone: 'brand' },
  DELIVERED: { label: 'Delivered', tone: 'success' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'error' },
};
/** Any status TikTok sends is shown; one this app has no wording for is shown as it came. */
export const orderStatus = (raw: string): { label: string; tone: Tone } =>
  ORDER_STATUS[raw] ?? { label: humanize(raw), tone: 'neutral' };

/** The statuses the mock tool offers, in the order an order moves through them. */
export const MOCK_STATUSES = [
  'UNPAID',
  'ON_HOLD',
  'AWAITING_SHIPMENT',
  'AWAITING_COLLECTION',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
] as const;

const NEXT_STATUS: Record<string, string> = {
  UNPAID: 'AWAITING_SHIPMENT',
  ON_HOLD: 'AWAITING_SHIPMENT',
  AWAITING_SHIPMENT: 'IN_TRANSIT',
  PARTIALLY_SHIPPING: 'IN_TRANSIT',
  AWAITING_COLLECTION: 'IN_TRANSIT',
  IN_TRANSIT: 'DELIVERED',
  DELIVERED: 'COMPLETED',
};
/** Where the mock tool's "next status" button moves an order, or null when there is nowhere further to go. */
export const nextStatus = (status: string): string | null => NEXT_STATUS[status] ?? null;

export const STOCK_STATE: Record<TikTokStockState, { label: string; tone: Tone; hint: string }> = {
  none: { label: 'No stock held', tone: 'neutral', hint: 'No stock is held for this order.' },
  reserved: {
    label: 'Stock reserved',
    tone: 'info',
    hint: 'Stock is held for this order. It leaves when TikTok says it shipped.',
  },
  shipped: {
    label: 'Stock shipped',
    tone: 'success',
    hint: 'The order shipped, so its stock has left.',
  },
  released: {
    label: 'Stock released',
    tone: 'neutral',
    hint: 'The order was cancelled before it shipped, so the stock is available again.',
  },
  needs_mapping: {
    label: 'Needs mapping',
    tone: 'warning',
    hint: 'A product on this order is not linked to one of yours. No stock has moved.',
  },
  stock_short: {
    label: 'Not enough stock',
    tone: 'warning',
    hint: 'Not enough available stock for the whole order. Nothing was reserved.',
  },
};
export const stockState = (raw: string) =>
  (STOCK_STATE as Record<string, (typeof STOCK_STATE)[TikTokStockState]>)[raw] ?? {
    label: humanize(raw),
    tone: 'neutral' as Tone,
    hint: 'OrderLoop does not know this stock state yet.',
  };

/** The stock filter, in the order of the chips. The second value is the filter sent to the API. */
export const STOCK_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'needs_mapping', label: 'Needs mapping' },
  { value: 'stock_short', label: 'Not enough stock' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'released', label: 'Released' },
  { value: 'none', label: 'No stock held' },
];

export const ATTENTION_TEXT = 'Cancelled after it shipped: stock was not changed, check it';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** One plain sentence on what the stock did for an order and why. */
export function explainStock(order: TikTokOrderSummary): string {
  switch (order.stockState) {
    case 'needs_mapping': {
      const n = Math.max(order.unmappedLineCount, 1);
      return `Waiting for you to map ${n} ${plural(n, 'item', 'items')}: no stock has been moved.`;
    }
    case 'stock_short':
      return 'There is not enough available stock for the whole order, so nothing was reserved. Receive stock, then press Sync now: OrderLoop also checks again every 10 minutes.';
    case 'reserved':
      return 'Stock is reserved for this order. It leaves your stock when TikTok says the order has shipped.';
    case 'shipped':
      return order.attention
        ? 'The stock shipped with the order and was not given back after the cancellation.'
        : 'The order has shipped, so its stock has left.';
    case 'released':
      return 'TikTok cancelled the order before it shipped, so the stock that was held is available again.';
    case 'none':
      if (order.status === 'CANCELLED') return 'The order was cancelled before any stock was held.';
      if (order.status === 'UNPAID') return 'The order is not paid yet, so no stock is held.';
      if (order.onHold || order.status === 'ON_HOLD')
        return 'The buyer can still cancel, so no stock is held yet.';
      return 'No stock is held for this order at this status.';
    default:
      return 'OrderLoop does not know this stock state yet, so it shows no explanation.';
  }
}

/** The totals of an order, in the order they are shown. */
export const totalsOf = (order: TikTokOrder) => [
  { label: 'Subtotal', minor: order.subtotalMinor },
  { label: 'Seller discount', minor: -Math.abs(order.sellerDiscountMinor) },
  { label: 'Platform discount', minor: -Math.abs(order.platformDiscountMinor) },
  { label: 'Shipping', minor: order.shippingMinor },
  { label: 'Tax', minor: order.taxMinor },
];

export const HOLD_LABEL: Record<string, string> = {
  held: 'Stock held',
  shipped: 'Stock shipped',
  released: 'Stock released',
};
export const holdLabel = (hold: string | null): string =>
  hold === null ? 'No stock yet' : (HOLD_LABEL[hold] ?? humanize(hold));

// ---- reading -----------------------------------------------------------------------------------------------------------

export function useTikTokOverview(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['tiktok', 'overview'],
    enabled,
    queryFn: () => api.tiktokShop.overview(),
  });
}

export function useTikTokSession(id: string | undefined, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['tiktok', 'session', id],
    enabled: enabled && !!id,
    retry: false,
    queryFn: () => api.tiktokShop.session(id!),
  });
}

/** How often the menu asks how many TikTok orders need a person. One small request: it reads counts, not the list. */
export const TIKTOK_COUNT_POLL_MS = 60_000;

/**
 * TikTok orders that need a person (waiting for a SKU link, short of stock, or cancelled after shipping): the count beside
 * "TikTok orders" in the menu. Someone who cannot read integrations gets the two stock counts from the order list.
 */
export function useTikTokAttentionCount(enabled: boolean) {
  const api = useApi();
  const can = useCan();
  const { status } = useAuth();
  const overview = can('integrations:read');
  return useQuery({
    queryKey: ['tiktokOrders', 'count', overview],
    enabled: enabled && status === 'authenticated',
    refetchInterval: TIKTOK_COUNT_POLL_MS,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      if (overview) {
        const o = await api.tiktokShop.overview();
        return o.needsMappingOrders + o.stockShortOrders + o.attentionOrders;
      }
      const { counts } = await api.tiktokOrders.list({ limit: 1 });
      return (counts['needs_mapping'] ?? 0) + (counts['stock_short'] ?? 0);
    },
  });
}

export interface TikTokOrderFilters {
  status: string;
  /** A stock state, or `attention` for the orders flagged for a person. */
  stock: string;
  connectionId: string;
}

/** TikTok orders, newest update first, a page at a time. */
export function useTikTokOrders(filters: TikTokOrderFilters, enabled = true) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ['tiktokOrders', 'list', filters],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.tiktokOrders.list({
        limit: 25,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.stock === 'attention'
          ? { attention: 'true' as const }
          : filters.stock
            ? { stockState: filters.stock as TikTokStockState }
            : {}),
        ...(filters.connectionId ? { connectionId: filters.connectionId } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useTikTokOrder(id: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['tiktokOrder', id],
    enabled,
    queryFn: () => api.tiktokOrders.get(id),
  });
}

/** SKU links, a page at a time: the ones waiting for a link, or all of them. */
export function useSkuLinks(unmapped: boolean, enabled = true) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ['tiktokSkuLinks', { unmapped }],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.tiktokSkuLinks.list({
        limit: 50,
        ...(unmapped ? { unmapped: 'true' as const } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** After anything that changes a shop, an order or a SKU link; stock changes too, so the catalogue refreshes. */
export const invalidateTikTok = (client: ReturnType<typeof useQueryClient>) =>
  invalidateKeys(client, [
    'tiktok',
    'tiktokOrders',
    'tiktokOrder',
    'tiktokSkuLinks',
    'products',
    'product',
    'inventory',
    'lowStock',
    'movements',
    'reservations',
    'dashboard',
  ]);

export const isMockShop = (c: TikTokConnection) => c.mock;
