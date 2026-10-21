import { AUTOMATION_KINDS } from '@orderloop/contracts';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildCodDiscrepancy,
  buildDelayed,
  buildLowStock,
  buildNewOrder,
  buildNewOrders,
  buildReport,
  buildUnconfirmed,
  dueSlot,
  firstInstantAtOrAfter,
  formatMoney,
  isoWeek,
  localParts,
  pushPayload,
  RECIPIENT_PERMISSION,
  reportWindow,
  roleCanReceive,
  scanSlot,
  tzOffsetMinutes,
  type BuiltNotification,
} from './automation.js';

const at = (iso: string) => new Date(iso);
const daily = (localTime: string) => ({ kind: 'DAILY_REPORT' as const, localTime });
const weekly = (localTime: string, weekday: number) => ({
  kind: 'WEEKLY_REPORT' as const,
  localTime,
  weekday,
});

describe('local time helpers', () => {
  it('reads the wall clock and offsets of a zone', () => {
    expect(localParts(at('2026-03-29T13:59:00Z'), 'Asia/Dhaka')).toMatchObject({
      date: '2026-03-29',
      minutesOfDay: 19 * 60 + 59,
      weekday: 0,
    });
    expect(tzOffsetMinutes(at('2026-01-01T00:00:00Z'), 'Asia/Dhaka')).toBe(360);
    expect(tzOffsetMinutes(at('2026-01-01T00:00:00Z'), 'Europe/London')).toBe(0);
    expect(tzOffsetMinutes(at('2026-07-01T00:00:00Z'), 'Europe/London')).toBe(60);
    expect(tzOffsetMinutes(at('2026-07-01T00:00:00Z'), 'America/New_York')).toBe(-240);
  });
  it('adds days and names ISO weeks, including the year boundary', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(isoWeek('2026-03-30')).toBe('2026-W14');
    expect(isoWeek('2026-12-31')).toBe('2026-W53');
    expect(isoWeek('2027-01-01')).toBe('2026-W53');
    expect(isoWeek('2024-12-30')).toBe('2025-W01');
  });
  it('first instant at or after a local time: ordinary, repeated and skipped', () => {
    expect(firstInstantAtOrAfter('2026-03-29', '20:00', 'Asia/Dhaka').toISOString()).toBe(
      '2026-03-29T14:00:00.000Z',
    );
    // London, clocks go back 25 Oct 2026 (02:00 BST -> 01:00 GMT): 01:30 happens twice, the first is 00:30Z
    expect(firstInstantAtOrAfter('2026-10-25', '01:30', 'Europe/London').toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    // London, clocks go forward 29 Mar 2026 (01:00 GMT -> 02:00 BST): 01:30 never happens, the first valid minute is 01:00Z
    expect(firstInstantAtOrAfter('2026-03-29', '01:30', 'Europe/London').toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    // New York, clocks go forward 8 Mar 2026: 02:30 does not exist, the clock passes it at 07:00Z (03:00 EDT)
    expect(firstInstantAtOrAfter('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    expect(firstInstantAtOrAfter('2026-03-08', '00:00', 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });
});

describe('dueSlot: Asia/Dhaka (no daylight saving)', () => {
  it('is not due before the local time and is due from it, with the local date as the key', () => {
    expect(dueSlot(at('2026-03-29T13:59:00Z'), 'Asia/Dhaka', daily('20:00'))).toBeNull();
    const due = dueSlot(at('2026-03-29T14:00:00Z'), 'Asia/Dhaka', daily('20:00'))!;
    expect(due.slotKey).toBe('daily:2026-03-29');
    expect(due.scheduledFor.toISOString()).toBe('2026-03-29T14:00:00.000Z');
    // every minute of the rest of the local day gives the same key (downtime catch-up fires once, same day)
    expect(dueSlot(at('2026-03-29T17:59:00Z'), 'Asia/Dhaka', daily('20:00'))!.slotKey).toBe(
      'daily:2026-03-29',
    );
  });
  it('a report missed for a whole local day is not sent the next morning', () => {
    // local midnight of 30 March in Dhaka is 18:00Z of the 29th
    expect(dueSlot(at('2026-03-29T18:00:00Z'), 'Asia/Dhaka', daily('20:00'))).toBeNull();
    expect(dueSlot(at('2026-03-30T03:00:00Z'), 'Asia/Dhaka', daily('20:00'))).toBeNull();
    expect(dueSlot(at('2026-03-30T14:00:00Z'), 'Asia/Dhaka', daily('20:00'))!.slotKey).toBe(
      'daily:2026-03-30',
    );
  });
  it('weekly: only on the chosen local weekday, keyed by the ISO week', () => {
    // Monday 30 March 2026 09:00 Dhaka = 03:00Z
    expect(dueSlot(at('2026-03-30T02:59:00Z'), 'Asia/Dhaka', weekly('09:00', 1))).toBeNull();
    expect(dueSlot(at('2026-03-30T03:00:00Z'), 'Asia/Dhaka', weekly('09:00', 1))!.slotKey).toBe(
      'weekly:2026-W14',
    );
    expect(dueSlot(at('2026-03-31T03:00:00Z'), 'Asia/Dhaka', weekly('09:00', 1))).toBeNull();
    expect(dueSlot(at('2026-04-06T03:00:00Z'), 'Asia/Dhaka', weekly('09:00', 1))!.slotKey).toBe(
      'weekly:2026-W15',
    );
  });
});

describe('dueSlot: Europe/London daylight saving', () => {
  it('spring forward: a skipped local time fires at the first valid minute of that day, once', () => {
    const rule = daily('01:30');
    expect(dueSlot(at('2026-03-29T00:59:00Z'), 'Europe/London', rule)).toBeNull(); // 00:59 GMT
    const first = dueSlot(at('2026-03-29T01:00:00Z'), 'Europe/London', rule)!; // 02:00 BST
    expect(first.slotKey).toBe('daily:2026-03-29');
    expect(first.scheduledFor.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(dueSlot(at('2026-03-29T09:00:00Z'), 'Europe/London', rule)!.slotKey).toBe(first.slotKey);
  });
  it('fall back: the repeated hour gives the same key both times, so it fires once', () => {
    const rule = daily('01:30');
    expect(dueSlot(at('2026-10-25T00:29:00Z'), 'Europe/London', rule)).toBeNull(); // 01:29 BST
    const a = dueSlot(at('2026-10-25T00:30:00Z'), 'Europe/London', rule)!; // 01:30 BST
    const between = dueSlot(at('2026-10-25T00:59:00Z'), 'Europe/London', rule)!; // 01:59 BST
    const b = dueSlot(at('2026-10-25T01:30:00Z'), 'Europe/London', rule)!; // 01:30 GMT, the second one
    expect(new Set([a.slotKey, between.slotKey, b.slotKey]).size).toBe(1);
    expect(a.slotKey).toBe('daily:2026-10-25');
    // while the clock is back in the 01:00 hour (01:00-01:29 GMT) the wall clock reads before 01:30 again: still the same slot
    expect(dueSlot(at('2026-10-25T01:00:00Z'), 'Europe/London', rule)).toBeNull();
    expect(a.scheduledFor.toISOString()).toBe(b.scheduledFor.toISOString());
  });
  it('the day with 23 or 25 hours still has exactly one slot', () => {
    const keys = new Set<string>();
    for (let m = 0; m < 25 * 60; m += 15) {
      const now = new Date(Date.parse('2026-10-24T23:00:00Z') + m * 60_000);
      const s = dueSlot(now, 'Europe/London', daily('09:00'));
      if (s && s.localDate === '2026-10-25') keys.add(s.slotKey);
    }
    expect([...keys]).toEqual(['daily:2026-10-25']);
  });
});

describe('dueSlot: America/New_York daylight saving', () => {
  it('spring forward 8 March 2026: 02:30 does not exist, due at 03:00 EDT, once', () => {
    const rule = daily('02:30');
    expect(dueSlot(at('2026-03-08T06:59:00Z'), 'America/New_York', rule)).toBeNull(); // 01:59 EST
    const due = dueSlot(at('2026-03-08T07:00:00Z'), 'America/New_York', rule)!; // 03:00 EDT
    expect(due.slotKey).toBe('daily:2026-03-08');
    expect(due.scheduledFor.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });
  it('fall back 1 November 2026: the repeated 01:30 is one slot', () => {
    const rule = daily('01:30');
    const first = dueSlot(at('2026-11-01T05:30:00Z'), 'America/New_York', rule)!; // 01:30 EDT
    const second = dueSlot(at('2026-11-01T06:30:00Z'), 'America/New_York', rule)!; // 01:30 EST
    expect(first.slotKey).toBe('daily:2026-11-01');
    expect(second.slotKey).toBe(first.slotKey);
  });
  it('weekly across a change of clocks keeps the ISO week key', () => {
    // Sunday 8 March 2026 (the spring-forward day), weekday 0 at 09:00 EDT = 13:00Z
    expect(dueSlot(at('2026-03-08T12:59:00Z'), 'America/New_York', weekly('09:00', 0))).toBeNull();
    expect(
      dueSlot(at('2026-03-08T13:00:00Z'), 'America/New_York', weekly('09:00', 0))!.slotKey,
    ).toBe('weekly:2026-W10');
  });
});

describe('dueSlot: changing time zone', () => {
  it('an instant already covered by a slot of that local date does not open a second one', () => {
    // fired in Dhaka at 20:00 on the 29th (14:00Z). The business then moves to Honolulu (UTC-10): it is 04:00 on the 29th
    // there; the same local date gives the same key, and 20:00 there has not arrived.
    expect(dueSlot(at('2026-03-29T14:00:00Z'), 'Asia/Dhaka', daily('20:00'))!.slotKey).toBe(
      'daily:2026-03-29',
    );
    expect(dueSlot(at('2026-03-29T14:00:00Z'), 'Pacific/Honolulu', daily('20:00'))).toBeNull();
    // moving to Auckland (UTC+13) at the same instant: 03:00 on the 30th, before 20:00, nothing due
    expect(dueSlot(at('2026-03-29T14:00:00Z'), 'Pacific/Auckland', daily('20:00'))).toBeNull();
    // later that evening Dhaka (29th 20:00 +): the key is still the 29th
    expect(dueSlot(at('2026-03-29T16:00:00Z'), 'Asia/Dhaka', daily('20:00'))!.slotKey).toBe(
      'daily:2026-03-29',
    );
  });
});

describe('scanSlot', () => {
  it('names the five-minute bucket, the same for every worker and every second inside it', () => {
    const a = scanSlot(at('2026-10-25T14:30:00.000Z'));
    expect(a.slotKey).toBe('scan:20261025T1430Z');
    expect(scanSlot(at('2026-10-25T14:34:59.999Z')).slotKey).toBe(a.slotKey);
    expect(scanSlot(at('2026-10-25T14:35:00.000Z')).slotKey).toBe('scan:20261025T1435Z');
    expect(a.scheduledFor.toISOString()).toBe('2026-10-25T14:30:00.000Z');
  });
});

describe('reportWindow', () => {
  it('daily is today from local midnight; weekly is the last 7 local days', () => {
    const now = at('2026-03-29T14:00:00Z');
    const d = reportWindow('DAILY_REPORT', '2026-03-29', 'Asia/Dhaka', now);
    expect(d.from.toISOString()).toBe('2026-03-28T18:00:00.000Z');
    expect(d.fromDate).toBe('2026-03-29');
    const w = reportWindow('WEEKLY_REPORT', '2026-03-29', 'Asia/Dhaka', now);
    expect(w.fromDate).toBe('2026-03-23');
    expect(w.from.toISOString()).toBe('2026-03-22T18:00:00.000Z');
  });
});

describe('who receives what', () => {
  it('maps every kind to a permission and applies it to roles', () => {
    for (const kind of AUTOMATION_KINDS) expect(RECIPIENT_PERMISSION[kind]).toBeDefined();
    expect(roleCanReceive('STAFF', 'LOW_STOCK')).toBe(true);
    expect(roleCanReceive('STAFF', 'NEW_ORDER')).toBe(true);
    expect(roleCanReceive('STAFF', 'COD_DISCREPANCY')).toBe(false);
    expect(roleCanReceive('STAFF', 'DAILY_REPORT')).toBe(false);
    expect(roleCanReceive('ACCOUNTANT', 'WEEKLY_REPORT')).toBe(true);
    expect(roleCanReceive('MANAGER', 'COD_DISCREPANCY')).toBe(true);
  });
});

describe('privacy: notification wording', () => {
  // Things a customer owns. None of them may ever appear, even if a caller hands them to a builder by mistake.
  const secrets = [
    'Rahim Uddin',
    '+8801712345678',
    '01712-345678',
    'rahim@example.test',
    'House 12, Road 5, Dhanmondi',
    'ship_name',
  ];
  const hostile = {
    customerName: secrets[0],
    phone: secrets[1],
    shipPhone: secrets[2],
    email: secrets[3],
    shipLine1: secrets[4],
  };
  const id = '0197b0a0-0000-7000-8000-000000000001';

  const all = (): { name: string; built: BuiltNotification }[] => [
    {
      name: 'low stock',
      built: buildLowStock(
        [{ variantId: id, sku: 'TEE-1', productName: 'Cotton tee', available: 2, ...hostile }],
        7,
      ),
    },
    {
      name: 'new order',
      built: buildNewOrder({ id, orderNumber: 1042, itemCount: 3, source: 'facebook', ...hostile }),
    },
    {
      name: 'new orders',
      built: buildNewOrders([{ id, orderNumber: 1042, ...hostile }], 9),
    },
    {
      name: 'unconfirmed',
      built: buildUnconfirmed([{ id, orderNumber: 1042, ...hostile }], 4, 60),
    },
    { name: 'delayed', built: buildDelayed([{ id, orderNumber: 1042, ...hostile }], 4, 48) },
    {
      name: 'cod',
      built: buildCodDiscrepancy([{ id, orderNumber: 1042, ...hostile }], 2),
    },
    {
      name: 'report',
      built: buildReport(
        'DAILY_REPORT',
        { fromDate: '2026-03-29', toDate: '2026-03-29' },
        {
          orders: 12,
          revenueMinor: 1_540_000,
          delivered: 8,
          cancelled: 1,
          lowStock: 3,
          openDiscrepancies: 0,
          ...hostile,
        } as never,
        'BDT',
      ),
    },
  ];

  it('no builder output (title, body, data, push payload) contains a customer field', () => {
    for (const { name, built } of all()) {
      const text = JSON.stringify(built) + JSON.stringify(pushPayload(built.data.kind, id));
      for (const secret of secrets) expect(text, `${name} leaked ${secret}`).not.toContain(secret);
      expect(Object.keys(built.data).sort(), name).toEqual(expect.arrayContaining(['kind']));
      expect(built.title.length).toBeGreaterThan(0);
    }
  });

  it('data holds only ids, counts and dates', () => {
    for (const { built } of all())
      for (const [key, value] of Object.entries(built.data)) {
        if (key === 'kind' || key === 'from' || key === 'to') expect(typeof value).toBe('string');
        else if (key === 'count') expect(typeof value).toBe('number');
        else {
          expect(Array.isArray(value), key).toBe(true);
          for (const v of value as string[]) expect(v).toBe(id);
        }
      }
  });

  it('the push payload is generic and carries only {kind, id}', () => {
    for (const kind of AUTOMATION_KINDS) {
      const p = pushPayload(kind, id);
      expect(Object.keys(p.data).sort()).toEqual(['id', 'kind']);
      expect(p.data).toEqual({ kind, id });
      expect(p.body).toBe('Open OrderLoop to see the details.');
      expect(p.title).not.toMatch(/#\d/); // no order numbers on a lock screen
    }
  });

  it('digests name at most five items and count the rest', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id,
      orderNumber: 2000 + i,
    }));
    const b = buildUnconfirmed(many, 12, 60);
    expect(b.data.orderIds).toHaveLength(5);
    expect(b.data.count).toBe(12);
    expect(b.body).toContain('and 7 more');
    expect(b.body).not.toContain('#2005');
  });

  it('formats money for reports (BDT grouping, other currencies)', () => {
    expect(formatMoney(1_540_000, 'BDT')).toBe('৳15,400.00');
    expect(formatMoney(123_456_789, 'BDT')).toBe('৳12,34,567.89');
    expect(formatMoney(1_234_500, 'USD')).toBe('12,345.00 USD');
  });
});
