import { describe, expect, it } from 'vitest';
import {
  deriveTikTokEventKey,
  parseTikTokOrder,
  parseTikTokWebhook,
  snapshotFromJson,
  snapshotToJson,
} from './parse.js';

const ctx = { region: 'MY', fallbackUpdatedAt: new Date('2026-10-22T10:00:00Z') };

const webhook = (over: Record<string, unknown> = {}) => ({
  type: 1,
  tts_notification_id: '7123456789',
  shop_id: '7494111111',
  timestamp: 1_790_000_000,
  data: {
    order_id: '5764',
    order_status: 'AWAITING_SHIPMENT',
    is_on_hold_order: false,
    update_time: 1_790_000_000,
  },
  ...over,
});

describe('parseTikTokWebhook', () => {
  it('reads the shop, the dedupe key, the order id and the status word', () => {
    expect(parseTikTokWebhook(webhook())).toMatchObject({
      shopId: '7494111111',
      key: '7123456789',
      type: 1,
      kind: 'order_status',
      orderId: '5764',
      orderStatus: 'AWAITING_SHIPMENT',
      onHold: false,
    });
    expect(parseTikTokWebhook(webhook())!.timestamp.toISOString()).toBe('2026-09-21T14:13:20.000Z');
  });

  it('classifies by the numeric type the SDK names, and by the shape of data when the type is unknown', () => {
    const kind = (type: unknown, data: object = {}) =>
      parseTikTokWebhook(webhook({ type, data }))!.kind;
    expect(kind(1)).toBe('order_status');
    expect(kind(4)).toBe('package');
    expect(kind(6)).toBe('deauthorization');
    expect(kind(3, { order_id: '1', order_status: 'X' })).toBe('other'); // an address update is never an order update
    expect(kind(5)).toBe('other');
    expect(kind(2, { order_id: '1', order_status: 'X' })).toBe('other');
    expect(kind(99, { order_id: '1', order_status: 'UNPAID' })).toBe('order_status');
    expect(kind(undefined, { order_id: '1', order_status: 'UNPAID' })).toBe('order_status');
    expect(kind(99, {})).toBe('other');
    expect(kind('1')).toBe('order_status');
  });

  it('a delivery without a notification id still gets a stable key', () => {
    const a = parseTikTokWebhook(webhook({ tts_notification_id: undefined }))!;
    const b = parseTikTokWebhook(webhook({ tts_notification_id: undefined }))!;
    expect(a.key).toMatch(/^derived_[0-9a-f]{40}$/);
    expect(a.key).toBe(b.key);
    const other = parseTikTokWebhook(
      webhook({
        tts_notification_id: undefined,
        data: { order_id: '5765', order_status: 'AWAITING_SHIPMENT' },
      }),
    )!;
    expect(other.key).not.toBe(a.key);
  });

  it('derives the key from shop, type, time, order and status (each one matters)', () => {
    const base = { shopId: 's', type: 1, timestamp: 1, orderId: 'o', orderStatus: 'X' };
    const k = deriveTikTokEventKey(base);
    expect(deriveTikTokEventKey({ ...base })).toBe(k);
    for (const change of [
      { shopId: 't' },
      { type: 4 },
      { timestamp: 2 },
      { orderId: 'p' },
      { orderStatus: 'Y' },
    ])
      expect(deriveTikTokEventKey({ ...base, ...change })).not.toBe(k);
  });

  it('refuses what is not a notification for a shop, and drops what it does not need', () => {
    for (const bad of [null, [], 'x', 7, {}, { shop_id: '' }, { shop_id: 'x'.repeat(65) }])
      expect(parseTikTokWebhook(bad)).toBeNull();
    const ev = parseTikTokWebhook(
      webhook({
        data: {
          order_id: '1',
          order_status: 'X',
          recipient_address: { name: 'Siti', full_address: 'No 1 Jalan X' },
        },
      }),
    )!;
    expect(JSON.stringify(ev)).not.toMatch(/Siti|Jalan/);
  });
});

const raw = (over: Record<string, unknown> = {}) => ({
  id: '5764',
  status: 'AWAITING_SHIPMENT',
  create_time: 1_790_000_000,
  update_time: 1_790_000_100,
  is_on_hold_order: false,
  fulfillment_type: 'FULFILLED_BY_SELLER',
  payment: {
    currency: 'MYR',
    sub_total: '30.00',
    shipping_fee: '2.50',
    seller_discount: '1.00',
    platform_discount: '0.50',
    tax: '0.60',
    total_amount: '31.00',
  },
  line_items: [
    { id: 'L1', sku_id: 'S1', seller_sku: 'TEE-M', product_name: 'Tee M', sale_price: '10.00' },
    { id: 'L2', sku_id: 'S1', seller_sku: 'TEE-M', product_name: 'Tee M', sale_price: '10.00' },
    { id: 'L3', sku_id: 'S2', seller_sku: null, product_name: 'Cap', sale_price: '10.00' },
  ],
  user_id: 'u-1',
  buyer_email: 'siti@buyer-example.my',
  buyer_message: 'leave it with the guard',
  recipient_address: {
    name: 'Siti Aminah',
    phone_number: '+60123456789',
    full_address: 'No 12, Jalan Bukit Bintang, Kuala Lumpur',
    postal_code: '55100',
    region_code: 'MY',
  },
  ...over,
});

describe('parseTikTokOrder', () => {
  it('adds one line item per unit up per SKU, in minor units of the shop currency, with the shop region', () => {
    const s = parseTikTokOrder(raw(), ctx)!;
    expect(s).toMatchObject({
      externalOrderId: '5764',
      status: 'AWAITING_SHIPMENT',
      onHold: false,
      currency: 'MYR',
      currencyExponent: 2,
      subtotalMinor: 3000n,
      sellerDiscountMinor: 100n,
      platformDiscountMinor: 50n,
      shippingMinor: 250n,
      taxMinor: 60n,
      totalMinor: 3100n,
      fulfilmentType: 'FULFILLED_BY_SELLER',
      region: 'MY',
    });
    expect(s.statusUpdatedAt.toISOString()).toBe('2026-09-21T14:15:00.000Z');
    expect(s.lines).toEqual([
      {
        key: 'sku:S1',
        externalSkuId: 'S1',
        externalLineId: 'L1',
        sellerSku: 'TEE-M',
        productName: 'Tee M',
        quantity: 2,
        unitPriceMinor: 1000n,
      },
      {
        key: 'sku:S2',
        externalSkuId: 'S2',
        externalLineId: 'L3',
        sellerSku: null,
        productName: 'Cap',
        quantity: 1,
        unitPriceMinor: 1000n,
      },
    ]);
  });

  it('honours a quantity field when one is present', () => {
    const s = parseTikTokOrder(
      raw({ line_items: [{ id: 'L1', sku_id: 'S1', quantity: 3, sale_price: '5' }] }),
      ctx,
    )!;
    expect(s.lines[0]).toMatchObject({ quantity: 3, unitPriceMinor: 500n });
  });

  it('keeps NOTHING of the buyer: no name, phone, email, address, message or user id, anywhere in the snapshot or its JSON', () => {
    const s = parseTikTokOrder(raw(), ctx)!;
    const text = JSON.stringify(snapshotToJson(s)) + JSON.stringify(Object.values(s).map(String));
    for (const needle of [
      'Siti',
      'Aminah',
      '60123456789',
      'buyer-example',
      'Jalan',
      'Bukit Bintang',
      '55100',
      'guard',
      'u-1',
    ])
      expect(text, needle).not.toContain(needle);
    expect(Object.keys(s).sort()).toEqual(
      [
        'createdAtTiktok',
        'currency',
        'currencyExponent',
        'externalOrderId',
        'fulfilmentType',
        'lines',
        'onHold',
        'platformDiscountMinor',
        'region',
        'sellerDiscountMinor',
        'shippingMinor',
        'statusUpdatedAt',
        'status',
        'subtotalMinor',
        'taxMinor',
        'totalMinor',
      ].sort(),
    );
  });

  it('reads the region from the shop, never from the buyer address', () => {
    const s = parseTikTokOrder(raw({ recipient_address: { region_code: 'ZZ' } }), {
      ...ctx,
      region: null,
    })!;
    expect(s.region).toBeNull();
  });

  it('treats zero-decimal currencies as such, and an on-hold flag as a flag', () => {
    const s = parseTikTokOrder(
      raw({
        is_on_hold_order: true,
        payment: { currency: 'jpy', sub_total: '1500', total_amount: '1600' },
      }),
      ctx,
    )!;
    expect(s).toMatchObject({
      currency: 'JPY',
      currencyExponent: 0,
      subtotalMinor: 1500n,
      totalMinor: 1600n,
      onHold: true,
    });
  });

  it('falls back to the read time when TikTok sent no update time, and to zero for a missing amount', () => {
    const s = parseTikTokOrder(raw({ update_time: undefined, payment: { currency: 'MYR' } }), ctx)!;
    expect(s.statusUpdatedAt).toEqual(ctx.fallbackUpdatedAt);
    expect(s.totalMinor).toBe(0n);
  });

  it('refuses an order with no id, no currency or no usable line', () => {
    expect(parseTikTokOrder(null, ctx)).toBeNull();
    expect(parseTikTokOrder(raw({ id: undefined }), ctx)).toBeNull();
    expect(parseTikTokOrder(raw({ payment: {} }), ctx)).toBeNull();
    expect(parseTikTokOrder(raw({ payment: { currency: 'RM' } }), ctx)).toBeNull();
    expect(parseTikTokOrder(raw({ line_items: [] }), ctx)).toBeNull();
    expect(parseTikTokOrder(raw({ line_items: [{ id: 'x' }] }), ctx)).toBeNull();
  });
});

describe('the snapshot as JSON', () => {
  it('round-trips, with money as strings', () => {
    const s = parseTikTokOrder(raw(), ctx)!;
    const json = snapshotToJson(s);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(json['totalMinor']).toBe('3100');
    expect(snapshotFromJson(JSON.parse(JSON.stringify(json)))).toEqual(s);
  });
  it('refuses JSON that is not one', () => {
    for (const bad of [null, [], {}, { externalOrderId: 'x' }, 'x'])
      expect(snapshotFromJson(bad)).toBeNull();
  });
});
