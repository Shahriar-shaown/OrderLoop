/** Calendar days written as YYYY-MM-DD, as the filters and the API take them. */
const DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A day that exists: "2026-02-28" yes, "2026-02-31" and "2026-13-45" no. */
export function isRealDay(text: string): boolean {
  const m = DAY_SHAPE.exec(text);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
