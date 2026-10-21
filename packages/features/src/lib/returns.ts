import type { ChangeStatusBody, OrderItem } from '@orderloop/contracts';

export type ReturnCondition = 'RESALEABLE' | 'DAMAGED';
/** What the person typed for one order line: how many came back (kept as text while typing) and in what state. */
export type ReturnPick = { quantity: string; condition: ReturnCondition };
export type ReturnPicks = Record<string, ReturnPick>;
type ReturnedItem = NonNullable<ChangeStatusBody['returnedItems']>[number];

/** Every line starts as "all of it came back, resaleable". */
export const startingPicks = (items: readonly OrderItem[]): ReturnPicks =>
  Object.fromEntries(
    items.map((i) => [i.id, { quantity: String(i.quantity), condition: 'RESALEABLE' as const }]),
  );

/** How many of a line came back, kept between 0 and what was sent. */
export function returnedQuantity(item: OrderItem, pick: ReturnPick | undefined): number {
  const n = Number(pick?.quantity ?? item.quantity);
  return Number.isInteger(n) ? Math.min(item.quantity, Math.max(0, n)) : 0;
}

/**
 * What to send for a `returned` move. The server brings back only the lines that are listed (and none of the others), so
 * every line that came back gets an entry. When the whole order came back resaleable the list is left out, which the
 * server reads the same way.
 */
export function returnPlan(items: readonly OrderItem[], picks: ReturnPicks) {
  const entries: { item: OrderItem; entry: ReturnedItem }[] = [];
  let everythingResaleable = true;
  for (const item of items) {
    const quantity = returnedQuantity(item, picks[item.id]);
    const condition = picks[item.id]?.condition ?? 'RESALEABLE';
    if (quantity < item.quantity || condition !== 'RESALEABLE') everythingResaleable = false;
    if (quantity === 0) continue;
    entries.push({
      item,
      entry: {
        itemId: item.id,
        condition,
        ...(quantity < item.quantity ? { quantity } : {}),
      },
    });
  }
  return {
    /** Nothing came back at all: the person has to say so by cancelling instead, not by marking a return. */
    nothing: entries.length === 0,
    returnedItems: everythingResaleable ? undefined : entries.map((e) => e.entry),
    entries,
  };
}

/** "1 of 2 Red / M": what came back of what was sent, for the line. */
export const lineName = (item: OrderItem) => item.variantName || item.productName || item.sku;

/**
 * The API says which entry of the list is wrong (`returnedItems.1.quantity`); the person sees lines. Maps each such error
 * to the id of the order line it belongs to.
 */
export function returnLineErrors(
  errors: Record<string, string>,
  entries: readonly { item: OrderItem }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(errors)) {
    const index = /^returnedItems\.(\d+)\.(?:quantity|itemId|condition)$/.exec(path)?.[1];
    const line = index === undefined ? undefined : entries[Number(index)];
    if (line) out[line.item.id] ??= message;
  }
  return out;
}
