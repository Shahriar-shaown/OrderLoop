import { translate } from '@orderloop/ui';
import {
  buildCodDiscrepancy,
  buildDelayed,
  buildLowStock,
  buildNewOrder,
  buildNewOrders,
  buildReport,
  buildUnconfirmed,
  type BuiltNotification,
} from '@orderloop/domain';
import { describe, expect, it } from 'vitest';
import { notificationBody } from '../lib/notificationText';
import './index';

const bn = (text: string) => translate('bn', text);
const id = (n: number) => `0197b0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const order = (n: number) => ({ id: id(n), orderNumber: 1000 + n });
const orders = (count: number) => Array.from({ length: count }, (_, i) => order(i + 1));
const variant = (n: number, available: number, name = `Product ${n}`) => ({
  variantId: id(n),
  sku: `SKU-${n}`,
  productName: name,
  available,
});
const metrics = (over: Partial<Parameters<typeof buildReport>[2]> = {}) => ({
  orders: 12,
  revenueMinor: 345600,
  delivered: 7,
  cancelled: 2,
  lowStock: 3,
  openDiscrepancies: 4,
  ...over,
});

/** Every notification the server can write, in the shapes that change its wording. */
const samples: [string, BuiltNotification][] = [
  ['low stock, one', buildLowStock([variant(1, 2, 'Glass vase')], 1)],
  ['low stock, some', buildLowStock([variant(1, 2), variant(2, 0)], 2)],
  [
    'low stock, many',
    buildLowStock(
      [1, 2, 3, 4, 5].map((n) => variant(n, n)),
      12,
    ),
  ],
  ['new order', buildNewOrder({ ...order(1), itemCount: 3, source: 'facebook' })],
  ['new order, one item', buildNewOrder({ ...order(1), itemCount: 1, source: 'phone_call' })],
  ['new order, walk-in', buildNewOrder({ ...order(1), itemCount: 2, source: 'walk_in' })],
  ['new orders, one', buildNewOrders(orders(1), 1)],
  ['new orders, few', buildNewOrders(orders(3), 3)],
  ['new orders, many', buildNewOrders(orders(5), 9)],
  ['waiting, one', buildUnconfirmed(orders(1), 1, 60)],
  ['waiting, few', buildUnconfirmed(orders(3), 3, 45)],
  ['waiting, many, in hours', buildUnconfirmed(orders(5), 8, 180)],
  ['late, one', buildDelayed(orders(1), 1, 48)],
  ['late, few', buildDelayed(orders(3), 3, 24)],
  ['late, many', buildDelayed(orders(5), 11, 72)],
  ['COD, one with an order', buildCodDiscrepancy([{ id: id(1), orderNumber: 1007 }], 1)],
  ['COD, one without', buildCodDiscrepancy([{ id: id(1), orderNumber: null }], 1)],
  [
    'COD, few',
    buildCodDiscrepancy(
      [1, 2, 3].map((n) => ({ id: id(n), orderNumber: 1000 + n })),
      3,
    ),
  ],
  [
    'COD, many',
    buildCodDiscrepancy(
      [1, 2, 3, 4, 5].map((n) => ({ id: id(n), orderNumber: 1000 + n })),
      9,
    ),
  ],
  [
    'daily report',
    buildReport('DAILY_REPORT', { fromDate: '2026-10-25', toDate: '2026-10-25' }, metrics(), 'BDT'),
  ],
  [
    'weekly report',
    buildReport(
      'WEEKLY_REPORT',
      { fromDate: '2026-10-19', toDate: '2026-10-25' },
      metrics({ orders: 1, lowStock: 1, openDiscrepancies: 1 }),
      'BDT',
    ),
  ],
  [
    'quiet report',
    buildReport(
      'DAILY_REPORT',
      { fromDate: '2026-10-25', toDate: '2026-10-25' },
      metrics({ orders: 0, revenueMinor: 0, lowStock: 0, openDiscrepancies: 0 }),
      'BDT',
    ),
  ],
];

// What may stay in English: product names and SKUs (the business's own words).
const OWN_WORDS = /Glass vase|Product \d|SKU-\d/g;
const leftover = (text: string) => text.replace(OWN_WORDS, '').match(/[A-Za-z]{3,}/g) ?? [];

describe('notifications in Bangla', () => {
  it.each(samples)('translates the title and text of: %s', (_name, built) => {
    const title = bn(built.title);
    const body = notificationBody({ kind: built.data.kind, body: built.body }, bn);
    expect(leftover(title), title).toEqual([]);
    expect(leftover(body), body).toEqual([]);
    expect(title).toMatch(/[ঀ-৿]/);
    expect(body).toMatch(/[ঀ-৿]/);
  });

  it('puts the numbers and names of the business into the sentence, with Bengali digits', () => {
    const low = buildLowStock([variant(1, 2, 'Glass vase')], 1);
    expect(notificationBody({ kind: 'LOW_STOCK', body: low.body }, bn)).toBe(
      'Glass vase (SKU-1): ২টি বাকি.',
    );
    const many = buildLowStock([variant(1, 2), variant(2, 0)], 5);
    expect(notificationBody({ kind: 'LOW_STOCK', body: many.body }, bn)).toBe(
      'Product 1 (SKU-1): ২টি বাকি; Product 2 (SKU-2): ০টি বাকি আরও ৩টি.',
    );
    expect(bn(buildLowStock([variant(1, 2)], 7).title)).toBe('স্টক কম: ৭টি পণ্য');
    expect(bn(buildNewOrder({ ...order(4), itemCount: 2, source: 'facebook' }).body)).toBe(
      'অর্ডার #১০০৪ এসেছে, ২টি পণ্য (ফেসবুক থেকে)।',
    );
    expect(bn(buildUnconfirmed(orders(1), 1, 60).body)).toBe(
      '#১০০১ ৬০ মিনিটের বেশি সময় ধরে অপেক্ষায় আছে।',
    );
    expect(bn(buildUnconfirmed(orders(2), 6, 180).body)).toBe(
      '#১০০১, #১০০২ এবং আরও ৪টি ৩ ঘণ্টার বেশি সময় ধরে অপেক্ষায় আছে।',
    );
  });

  it('leaves text of an unknown shape in English rather than guessing', () => {
    expect(notificationBody({ kind: 'LOW_STOCK', body: 'Something else entirely.' }, bn)).toBe(
      'Something else entirely.',
    );
  });
});
