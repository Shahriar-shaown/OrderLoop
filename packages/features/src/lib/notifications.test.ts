import type { AutomationKind, Permission } from '@orderloop/contracts';
import { describe, expect, it } from 'vitest';
import { notificationTarget } from './notifications';

const everything = () => true;
const nothing = () => false;
const order = '0197b0a0-0000-7000-8000-000000000001';
const go = (
  kind: AutomationKind,
  data: Record<string, unknown> = {},
  can: (p: Permission) => boolean = everything,
) => notificationTarget({ kind, data: { kind, ...data } }, can);

describe('where a notification leads', () => {
  it('opens the low-stock list', () => {
    expect(go('LOW_STOCK', { count: 3 })).toBe('/products?tab=low');
  });

  it('opens the order itself when the notification is about exactly one', () => {
    for (const kind of ['NEW_ORDER', 'UNCONFIRMED_ORDER', 'DELAYED_ORDER'] as const)
      expect(go(kind, { count: 1, orderIds: [order] }), kind).toBe(`/orders/${order}`);
  });

  it('opens the list that shows many, filtered to the waiting ones for a reminder', () => {
    const many = { count: 7, orderIds: [order, order] };
    expect(go('NEW_ORDER', many)).toBe('/orders');
    expect(go('DELAYED_ORDER', many)).toBe('/orders');
    expect(go('UNCONFIRMED_ORDER', many)).toBe('/orders?status=pending_confirmation');
    // Five ids named, but a count of more: it is about many orders even though one id travelled.
    expect(go('UNCONFIRMED_ORDER', { count: 2, orderIds: [order] })).toBe(
      '/orders?status=pending_confirmation',
    );
  });

  it('opens the cash on delivery page for a discrepancy', () => {
    expect(go('COD_DISCREPANCY', { count: 1, discrepancyIds: [order] })).toBe('/cod');
  });

  it('opens the dashboard for the daily report and analytics for the weekly one (dashboard without finance access)', () => {
    expect(go('DAILY_REPORT', { from: '2026-10-26', to: '2026-10-26' })).toBe('/dashboard');
    expect(go('WEEKLY_REPORT')).toBe('/analytics');
    expect(go('WEEKLY_REPORT', {}, nothing)).toBe('/dashboard');
  });

  it('still opens the right kind of screen when the data is unreadable', () => {
    expect(notificationTarget({ kind: 'NEW_ORDER', data: { orderIds: 'oops' } }, everything)).toBe(
      '/orders',
    );
    expect(notificationTarget({ kind: 'LOW_STOCK', data: {} }, everything)).toBe(
      '/products?tab=low',
    );
  });

  it('never puts anything but a real id into the path', () => {
    expect(go('NEW_ORDER', { count: 1, orderIds: ['../settings?x'] })).toBe('/orders');
  });
});
