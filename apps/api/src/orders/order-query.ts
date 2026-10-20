import type { OrderFilters, OrderQuery } from '@orderloop/contracts';
import { Prisma, UUID_RE } from '@orderloop/db';

const SORT_COLUMN = {
  createdAt: Prisma.raw('o.created_at'),
  orderNumber: Prisma.raw('o.order_number'),
  totalMinor: Prisma.raw('o.total_minor'),
  status: Prisma.raw('o.status'),
} as const;

/** `%` and `_` typed by a person must match themselves, not act as wildcards. */
const like = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The digits of a phone fragment without the country or trunk prefix, so "01712", "+88017" and "1712" all find +8801712... */
const phoneFragment = (q: string): string | null => {
  const digits = q.replace(/\D/g, '').replace(/^(?:880|0)/, '');
  return digits.length >= 3 && /^[\d\s+\-().]+$/.test(q) ? digits : null;
};

/**
 * The WHERE clause for the order list, the customer history and the export, so a filter means the same everywhere.
 * Everything a person typed goes in as a bound parameter. The tenant is always the first condition.
 */
export function orderWhere(
  tenantId: string,
  f: OrderFilters,
  timezone: string,
  extra: Prisma.Sql[] = [],
): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`o.tenant_id = ${tenantId}::uuid`, ...extra];
  if (f.status?.length)
    parts.push(
      Prisma.sql`o.status IN (${Prisma.join(f.status.map((s) => Prisma.sql`${s}::"OrderStatus"`))})`,
    );
  if (f.source?.length)
    parts.push(
      Prisma.sql`o.source IN (${Prisma.join(f.source.map((s) => Prisma.sql`${s}::"OrderSource"`))})`,
    );
  if (f.customerId) parts.push(Prisma.sql`o.customer_id = ${f.customerId}::uuid`);
  if (f.from)
    parts.push(Prisma.sql`o.created_at >= (${f.from}::date)::timestamp AT TIME ZONE ${timezone}`);
  if (f.to)
    parts.push(
      Prisma.sql`o.created_at < ((${f.to}::date) + 1)::timestamp AT TIME ZONE ${timezone}`,
    );
  if (f.minTotalMinor !== undefined) parts.push(Prisma.sql`o.total_minor >= ${f.minTotalMinor}`);
  if (f.maxTotalMinor !== undefined) parts.push(Prisma.sql`o.total_minor <= ${f.maxTotalMinor}`);
  if (f.q) {
    const q = f.q.trim();
    const number = /^#?(\d{1,9})$/.exec(q);
    const phone = phoneFragment(q);
    const text = like(q.toLowerCase());
    const alternatives: Prisma.Sql[] = [
      Prisma.sql`lower(c.name) LIKE ${text}`,
      Prisma.sql`lower(o.ship_name) LIKE ${text}`,
      Prisma.sql`EXISTS (SELECT 1 FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id
                 AND (lower(i.sku) LIKE ${text} OR lower(i.product_name) LIKE ${text}))`,
    ];
    if (number) alternatives.push(Prisma.sql`o.order_number = ${Number(number[1])}`);
    if (phone)
      alternatives.push(
        Prisma.sql`o.ship_phone LIKE ${like(phone)}`,
        Prisma.sql`c.phone LIKE ${like(phone)}`,
      );
    parts.push(Prisma.sql`(${Prisma.join(alternatives, ' OR ')})`);
  }
  return Prisma.join(parts, ' AND ');
}

export interface SortCursor {
  /** The sort column's value on the last row of the previous page. */
  v: string | number;
  id: string;
}

export const encodeOrderCursor = (c: SortCursor): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

export function decodeOrderCursor(cursor: string): SortCursor | undefined {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as SortCursor;
    if ((typeof c.v !== 'string' && typeof c.v !== 'number') || !UUID_RE.test(c.id))
      return undefined;
    return c;
  } catch {
    return undefined;
  }
}

/** Keyset paging: rows strictly after the cursor in (sort column, id) order, in either direction. Stable under inserts. */
export function afterCursor(
  sort: OrderQuery['sort'],
  dir: OrderQuery['dir'],
  cursor: SortCursor,
): Prisma.Sql {
  const col = SORT_COLUMN[sort];
  const cmp = Prisma.raw(dir === 'asc' ? '>' : '<');
  const value =
    sort === 'createdAt'
      ? Prisma.sql`${String(cursor.v)}::timestamptz`
      : sort === 'status'
        ? Prisma.sql`${String(cursor.v)}::"OrderStatus"`
        : Prisma.sql`${Number(cursor.v)}`;
  return Prisma.sql`(${col} ${cmp} ${value} OR (${col} = ${value} AND o.id ${cmp} ${cursor.id}::uuid))`;
}

export const orderBy = (sort: OrderQuery['sort'], dir: OrderQuery['dir']): Prisma.Sql => {
  const d = Prisma.raw(dir === 'asc' ? 'ASC' : 'DESC');
  return Prisma.sql`${SORT_COLUMN[sort]} ${d}, o.id ${d}`;
};

export const sortColumn = (sort: OrderQuery['sort']): Prisma.Sql => SORT_COLUMN[sort];
