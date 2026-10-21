import type { AutomationKind, NotificationData, Permission, Role } from '@orderloop/contracts';
import { can } from './permissions.js';

/**
 * Automation rules as pure functions: who may receive each kind, when a report is due in a business's own time zone, which
 * slot a scan belongs to, and the words of every notification. Nothing here touches the clock, the database or the network,
 * so the daylight-saving and privacy rules can be tested exhaustively.
 */

// ---- who receives what ------------------------------------------------------------------------------------------------

/** A person receives a kind of notification only if their role holds this permission in that business. */
export const RECIPIENT_PERMISSION: Readonly<Record<AutomationKind, Permission>> = {
  LOW_STOCK: 'inventory:read',
  NEW_ORDER: 'orders:read',
  UNCONFIRMED_ORDER: 'orders:read',
  DELAYED_ORDER: 'orders:read',
  COD_DISCREPANCY: 'finance:read',
  DAILY_REPORT: 'finance:read',
  WEEKLY_REPORT: 'finance:read',
};

export const roleCanReceive = (role: Role, kind: AutomationKind): boolean =>
  can(role, RECIPIENT_PERMISSION[kind]);

// ---- scan slots -------------------------------------------------------------------------------------------------------

export const SCAN_BUCKET_MS = 5 * 60_000;

/** Kinds that are found by looking at the data every five minutes. */
export const SCAN_KINDS: readonly AutomationKind[] = [
  'LOW_STOCK',
  'NEW_ORDER',
  'UNCONFIRMED_ORDER',
  'DELAYED_ORDER',
  'COD_DISCREPANCY',
];
export const REPORT_KINDS: readonly AutomationKind[] = ['DAILY_REPORT', 'WEEKLY_REPORT'];
export const isReportKind = (kind: AutomationKind): boolean => REPORT_KINDS.includes(kind);

/** The five-minute bucket containing `now`: `scan:20261025T1430Z` is 14:30 to 14:35 UTC. Every worker computes the same key. */
export function scanSlot(now: Date): { slotKey: string; scheduledFor: Date } {
  const start = Math.floor(now.getTime() / SCAN_BUCKET_MS) * SCAN_BUCKET_MS;
  const iso = new Date(start).toISOString(); // 2026-10-25T14:30:00.000Z
  return {
    slotKey: `scan:${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`,
    scheduledFor: new Date(start),
  };
}

// ---- local time -------------------------------------------------------------------------------------------------------

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** `2026-03-29`. */
  date: string;
  minutesOfDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
const WEEKDAY = (y: number, m: number, d: number): number =>
  new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** The wall-clock reading in `tz` at the instant `at`. Throws RangeError for an unknown zone. */
export function localParts(at: Date, tz: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(at))
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const { year = 0, month = 1, day = 1, hour = 0, minute = 0 } = parts;
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: WEEKDAY(year, month, day),
    date: `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
    minutesOfDay: hour * 60 + minute,
  };
}

/** Minutes the zone is ahead of UTC at that instant (Dhaka +360; London +60 in summer). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const p = formatter(tz).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

const parseDate = (date: string): [number, number, number] => {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return [y, m, d];
};

/** Add whole days to a local date string (calendar arithmetic, no zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * The first instant at which the wall clock in `tz` reads `date` `HH:mm` or later.
 *  - An ordinary time: that moment.
 *  - A time that happens twice (the clocks go back): the first one.
 *  - A time that never happens (the clocks jump forward over it): the moment the clock first passes it, the first valid minute.
 */
export function firstInstantAtOrAfter(date: string, localTime: string, tz: string): Date {
  const [y, m, d] = parseDate(date);
  const [hh = 0, mm = 0] = localTime.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  const target = (at: Date) => {
    const p = localParts(at, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  // The zone's offset can only differ by hours within a day around this time; try the offsets on both sides.
  const around = new Date(wanted);
  const offsets = new Set<number>();
  for (const h of [-36, -24, -12, 0, 12, 24, 36])
    offsets.add(tzOffsetMinutes(new Date(around.getTime() + h * 3_600_000), tz));
  const exact: number[] = [];
  for (const off of offsets) {
    const candidate = wanted - off * 60_000;
    if (target(new Date(candidate)) === wanted) exact.push(candidate);
  }
  if (exact.length) return new Date(Math.min(...exact));
  // A gap: search for the first minute whose wall clock is past the wanted time.
  let lo = wanted - 36 * 3_600_000;
  let hi = wanted + 36 * 3_600_000;
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000;
    if (target(new Date(mid)) >= wanted) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/** ISO 8601 week of a local date: `2026-W13` (the year is the week-year, which can differ from the calendar year in early January). */
export function isoWeek(date: string): string {
  const [y, m, d] = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  t.setUTCDate(t.getUTCDate() + 4 - day); // the Thursday of this week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${pad(t.getUTCFullYear(), 4)}-W${pad(week)}`;
}

// ---- report slots -----------------------------------------------------------------------------------------------------

export type ReportRule =
  | { kind: 'DAILY_REPORT'; localTime: string }
  | { kind: 'WEEKLY_REPORT'; localTime: string; weekday: number };

export interface DueSlot {
  /** `daily:2026-03-29` or `weekly:2026-W13`. Unique per rule, so the same slot can never run twice. */
  slotKey: string;
  /** When the report was meant to go out (the first valid instant of that local time). */
  scheduledFor: Date;
  /** The local date the slot belongs to. */
  localDate: string;
}

/**
 * The report slot that is due right now for a business in `tz`, or null when none is.
 *
 * The slot is named by the LOCAL DATE (daily) or the local ISO week (weekly), never by an instant:
 *  - the clocks go back and the target hour happens twice: both give the same key, so it fires once;
 *  - the clocks jump forward over the target time: the wall clock passes it at the first valid minute, and the report is due then;
 *  - the worker was down: the report is due as soon as it is back, but only until local midnight, so a day that was missed
 *    entirely is not sent the next morning. A report is therefore never sent twice and never sent for a day that has ended;
 *  - the business changes its time zone: the key is the local date in the zone at that moment, so an instant that was already
 *    covered (same local date) stays covered, and a new local date is a new day.
 */
export function dueSlot(now: Date, tz: string, rule: ReportRule): DueSlot | null {
  const local = localParts(now, tz);
  const [hh = 0, mm = 0] = rule.localTime.split(':').map(Number);
  if (local.minutesOfDay < hh * 60 + mm) return null;
  if (rule.kind === 'WEEKLY_REPORT' && local.weekday !== rule.weekday) return null;
  return {
    slotKey: slotKeyFor(rule.kind, local.date),
    scheduledFor: firstInstantAtOrAfter(local.date, rule.localTime, tz),
    localDate: local.date,
  };
}

const slotKeyFor = (kind: ReportRule['kind'], localDate: string): string =>
  kind === 'DAILY_REPORT' ? `daily:${localDate}` : `weekly:${isoWeek(localDate)}`;

/**
 * The slot a report requested right now belongs to, whether or not its time has come: today's (daily) or this week's (weekly).
 * A manual run uses it, so running a report by hand counts as that day's report and the scheduler does not send it again.
 */
export function currentReportSlot(
  now: Date,
  tz: string,
  kind: ReportRule['kind'],
): { slotKey: string; localDate: string } {
  const { date } = localParts(now, tz);
  return { slotKey: slotKeyFor(kind, date), localDate: date };
}

/** What a report covers: from local midnight of the first day to `now`. Daily: today. Weekly: the last 7 days including today. */
export function reportWindow(
  kind: 'DAILY_REPORT' | 'WEEKLY_REPORT',
  localDate: string,
  tz: string,
  now: Date,
): { from: Date; to: Date; fromDate: string; toDate: string } {
  const fromDate = kind === 'DAILY_REPORT' ? localDate : addDays(localDate, -6);
  return {
    from: firstInstantAtOrAfter(fromDate, '00:00', tz),
    to: now,
    fromDate,
    toDate: localDate,
  };
}

// ---- notification wording ---------------------------------------------------------------------------------------------

/**
 * A notification, as stored: it names things only by what a business owns itself (order numbers, SKUs, product names, counts
 * and business totals). It never carries a customer's name, phone, address or email, nor an amount tied to a person.
 */
export interface BuiltNotification {
  title: string;
  body: string;
  data: NotificationData;
}

/** At most this many ids travel in `data` and are named in the text; the rest are a count. */
export const DIGEST_TOP = 5;

const clip = (s: string, n = 40): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const more = (total: number, shown: number): string =>
  total > shown ? ` and ${total - shown} more` : '';

export function formatMoney(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = String(Math.floor(abs / 100));
  const frac = String(abs % 100).padStart(2, '0');
  if (currency === 'BDT') {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3);
    const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
    return `${sign}৳${grouped}.${frac}`;
  }
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac} ${currency}`;
}

export function buildLowStock(
  items: { variantId: string; sku: string; productName: string; available: number }[],
  total: number,
): BuiltNotification {
  const top = items.slice(0, DIGEST_TOP);
  const names = top.map(
    (i) => `${clip(i.productName)} (${i.sku}): ${Math.max(i.available, 0)} left`,
  );
  return {
    title: total === 1 ? 'Low stock: 1 item' : `Low stock: ${total} items`,
    body: `${names.join('; ')}${more(total, top.length)}.`,
    data: { kind: 'LOW_STOCK', count: total, variantIds: top.map((i) => i.variantId) },
  };
}

export function buildNewOrder(order: {
  id: string;
  orderNumber: number;
  itemCount: number;
  source: string;
}): BuiltNotification {
  return {
    title: `New order #${order.orderNumber}`,
    body: `Order #${order.orderNumber} came in with ${plural(order.itemCount, 'item')} (via ${order.source.replace('_', ' ')}).`,
    data: { kind: 'NEW_ORDER', count: 1, orderIds: [order.id] },
  };
}

export function buildNewOrders(
  orders: { id: string; orderNumber: number }[],
  total: number,
): BuiltNotification {
  if (total === 1 && orders[0])
    return {
      title: `New order #${orders[0].orderNumber}`,
      body: `Order #${orders[0].orderNumber} came in.`,
      data: { kind: 'NEW_ORDER', count: 1, orderIds: [orders[0].id] },
    };
  const top = orders.slice(0, DIGEST_TOP);
  return {
    title: `${total} new orders`,
    body: `${top.map((o) => `#${o.orderNumber}`).join(', ')}${more(total, top.length)} came in.`,
    data: { kind: 'NEW_ORDER', count: total, orderIds: top.map((o) => o.id) },
  };
}

export function buildUnconfirmed(
  orders: { id: string; orderNumber: number }[],
  total: number,
  afterMinutes: number,
): BuiltNotification {
  const top = orders.slice(0, DIGEST_TOP);
  const wait =
    afterMinutes >= 120 ? `${Math.round(afterMinutes / 60)} hours` : `${afterMinutes} minutes`;
  return {
    title: `${plural(total, 'order')} waiting for confirmation`,
    body: `${top.map((o) => `#${o.orderNumber}`).join(', ')}${more(total, top.length)} ${total === 1 ? 'has' : 'have'} been waiting more than ${wait}.`,
    data: { kind: 'UNCONFIRMED_ORDER', count: total, orderIds: top.map((o) => o.id) },
  };
}

export function buildDelayed(
  orders: { id: string; orderNumber: number }[],
  total: number,
  afterHours: number,
): BuiltNotification {
  const top = orders.slice(0, DIGEST_TOP);
  return {
    title: `${plural(total, 'order')} running late`,
    body: `${top.map((o) => `#${o.orderNumber}`).join(', ')}${more(total, top.length)} ${total === 1 ? 'is' : 'are'} not delivered ${afterHours} hours after being confirmed or shipped.`,
    data: { kind: 'DELAYED_ORDER', count: total, orderIds: top.map((o) => o.id) },
  };
}

export function buildCodDiscrepancy(
  items: { id: string; orderNumber: number | null }[],
  total: number,
): BuiltNotification {
  const top = items.slice(0, DIGEST_TOP);
  const numbers = top.filter((i) => i.orderNumber !== null).map((i) => `#${i.orderNumber}`);
  return {
    title: `${plural(total, 'COD discrepancy', 'COD discrepancies')} to review`,
    body: `${total === 1 ? 'A cash on delivery difference needs' : `${total} cash on delivery differences need`} review${numbers.length ? `: ${numbers.join(', ')}${more(total, top.length)}` : ''}.`,
    data: { kind: 'COD_DISCREPANCY', count: total, discrepancyIds: top.map((i) => i.id) },
  };
}

export interface ReportMetrics {
  orders: number;
  revenueMinor: number;
  delivered: number;
  cancelled: number;
  lowStock: number;
  openDiscrepancies: number;
}

export function buildReport(
  kind: 'DAILY_REPORT' | 'WEEKLY_REPORT',
  period: { fromDate: string; toDate: string },
  m: ReportMetrics,
  currency: string,
): BuiltNotification {
  const label =
    kind === 'DAILY_REPORT'
      ? `Daily report ${period.toDate}`
      : `Weekly report ${period.fromDate} to ${period.toDate}`;
  return {
    title: label,
    body: `${plural(m.orders, 'order')}, revenue ${formatMoney(m.revenueMinor, currency)}, ${m.delivered} delivered, ${m.cancelled} cancelled. ${plural(m.lowStock, 'item')} low on stock, ${plural(m.openDiscrepancies, 'open COD discrepancy', 'open COD discrepancies')}.`,
    data: { kind, from: period.fromDate, to: period.toDate },
  };
}

/** The headline a phone's lock screen shows: generic by design (see {@link pushPayload}). */
export const PUSH_TITLE: Readonly<Record<AutomationKind, string>> = {
  LOW_STOCK: 'Low stock alert',
  NEW_ORDER: 'New order',
  UNCONFIRMED_ORDER: 'Orders waiting for confirmation',
  DELAYED_ORDER: 'Orders running late',
  COD_DISCREPANCY: 'COD discrepancies to review',
  DAILY_REPORT: 'Your daily report is ready',
  WEEKLY_REPORT: 'Your weekly report is ready',
};

/**
 * What goes to the push service (Apple, Google and Expo see it): a generic title and body and the ids to open the right screen.
 * The app fetches the notification after the person has signed in, so nothing about the business crosses a third party.
 */
export function pushPayload(
  kind: AutomationKind,
  notificationId: string,
): { title: string; body: string; data: { kind: AutomationKind; id: string } } {
  return {
    title: PUSH_TITLE[kind],
    body: 'Open OrderLoop to see the details.',
    data: { kind, id: notificationId },
  };
}
