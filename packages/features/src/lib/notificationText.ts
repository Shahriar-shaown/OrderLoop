import type { Notification } from '@orderloop/contracts';

type Translate = (text: string) => string;

const ITEM = /^(.*) \((.*)\): (\d+) left$/;

/**
 * The text of a notification in the person's language. The server writes it in English; most kinds are translated whole by
 * the catalogue's patterns. A low-stock list names products, and a product name is not something a pattern can recognise, so
 * its items are taken apart here: the product and SKU stay as written and the rest is translated. Text that does not have the
 * expected shape is translated as it is, or stays English.
 */
export function notificationBody(
  notification: Pick<Notification, 'kind' | 'body'>,
  t: Translate,
): string {
  const { kind, body } = notification;
  if (kind !== 'LOW_STOCK') return t(body);
  const tail = /^([\s\S]*?)(?: and (\d+) more)?\.$/.exec(body);
  const items = tail?.[1] ? tail[1].split('; ').map((part) => ITEM.exec(part)) : [];
  if (!tail || items.length === 0 || items.some((item) => !item)) return t(body);
  const list = items.map((item) => `${item![1]} (${item![2]}): ${t(`${item![3]} left`)}`);
  return `${list.join('; ')}${tail[2] ? ` ${t(`and ${tail[2]} more`)}` : ''}.`;
}
