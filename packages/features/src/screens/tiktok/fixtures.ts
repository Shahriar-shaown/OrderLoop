import type {
  TikTokConnection,
  TikTokOrder,
  TikTokOrderLine,
  TikTokOrderSummary,
  TikTokOverview,
  TikTokSkuLink,
} from '@orderloop/contracts';

export const uuid = (n: number) => `0197b0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const NOW = '2026-10-21T09:00:00.000Z';
export const MOCK_BANNER = 'Mock integration: not connected to TikTok';

export const connection = (over: Partial<TikTokConnection> = {}): TikTokConnection => ({
  id: uuid(1),
  shopId: 'mock_abc',
  shopName: 'Demo TikTok shop',
  region: 'MY',
  sellerType: 'LOCAL',
  currency: 'MYR',
  status: 'active',
  mock: true,
  scopes: [],
  tokenExpiresAt: null,
  lastSyncedAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  connectedAt: NOW,
  disconnectedAt: null,
  ...over,
});

export const overview = (over: Partial<TikTokOverview> = {}): TikTokOverview => ({
  mode: 'mock',
  liveConfigured: false,
  webhookUrl: null,
  redirectUrl: null,
  connections: [],
  needsMappingOrders: 0,
  stockShortOrders: 0,
  attentionOrders: 0,
  unmappedSkus: 0,
  ...over,
});

export const summary = (over: Partial<TikTokOrderSummary> = {}): TikTokOrderSummary => ({
  id: uuid(100),
  connectionId: uuid(1),
  shopName: 'Demo TikTok shop',
  region: 'MY',
  externalOrderId: 'TT-1001',
  status: 'AWAITING_SHIPMENT',
  onHold: false,
  statusUpdatedAt: NOW,
  createdAtTiktok: NOW,
  currency: 'MYR',
  currencyExponent: 2,
  totalMinor: 2450,
  unitCount: 2,
  stockState: 'reserved',
  attention: null,
  unmappedLineCount: 0,
  mock: true,
  ...over,
});

export const line = (over: Partial<TikTokOrderLine> = {}): TikTokOrderLine => ({
  key: 'sku:s1',
  externalSkuId: 's1',
  sellerSku: 'TEE-1',
  productName: 'Cotton tee',
  quantity: 2,
  unitPriceMinor: 1000,
  variant: {
    id: uuid(7),
    sku: 'TEE-1',
    productName: 'Cotton tee',
    variantName: 'Red / M',
  },
  mapped: true,
  hold: 'held',
  skuLinkId: uuid(300),
  ...over,
});

export const detail = (over: Partial<TikTokOrder> = {}): TikTokOrder => ({
  ...summary(),
  mode: 'mock',
  subtotalMinor: 2000,
  sellerDiscountMinor: 100,
  platformDiscountMinor: 50,
  shippingMinor: 500,
  taxMinor: 100,
  fulfilmentType: 'FULFILLED_BY_SELLER',
  lines: [line()],
  ...over,
});

export const skuLink = (over: Partial<TikTokSkuLink> = {}): TikTokSkuLink => ({
  id: uuid(300),
  connectionId: uuid(1),
  shopName: 'Demo TikTok shop',
  externalSkuId: 's9',
  sellerSku: 'RED-HAT',
  productName: 'Red hat',
  variant: null,
  source: 'manual',
  waitingOrders: 2,
  updatedAt: NOW,
  ...over,
});

/** The catalogue the variant picker searches: one product with one variant. */
export const catalogue = (sku = 'TEE-1') => ({
  products: {
    list: async () => ({
      items: [
        {
          id: uuid(900),
          name: 'Cotton tee',
          status: 'ACTIVE',
          variants: [
            {
              id: uuid(7),
              productId: uuid(900),
              sku,
              name: 'Red / M',
              attributes: {},
              priceMinor: 85000,
              costMinor: null,
              barcode: null,
              reorderPoint: 0,
              archived: false,
              stock: { onHand: 10, reserved: 0, available: 10, damaged: 0 },
            },
          ],
        },
      ],
      nextCursor: null,
    }),
  },
});
