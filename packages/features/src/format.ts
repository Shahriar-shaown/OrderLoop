/** Format an ISO timestamp for people, in their own locale and time zone. */
export function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

/** A variant as a person names it: "Cotton tee — Red / M". */
export function variantLabel(productName: string, variantName: string): string {
  return variantName ? `${productName} — ${variantName}` : productName;
}

const SHORT_DAY = { day: 'numeric', month: 'short' } as const;

/** "17 Oct" from a calendar day (YYYY-MM-DD) or an ISO instant. */
export function formatShortDay(value: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return new Intl.DateTimeFormat('en-GB', SHORT_DAY).format(d);
}

/** "Sat, 17 Oct" from a calendar day. */
export function formatWeekdayDay(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${value}T00:00:00`));
}

/** "17 Oct, 11:30" from an ISO instant. */
export function formatDayTime(iso: string): string {
  const d = new Date(iso);
  return `${new Intl.DateTimeFormat('en-GB', SHORT_DAY).format(d)}, ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d)}`;
}

/** A calendar day (YYYY-MM-DD) in the viewer's own calendar, `days` before today. */
export function dayBefore(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "5 min ago", "3 h ago", "2 days ago". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} day${s >= 172_800 ? 's' : ''} ago`;
}
