import { createHash } from 'node:crypto';

export type MetaProvider = 'facebook_page' | 'instagram';

/** One thing Meta told us, reduced to what we keep. Nothing here is a name, a profile, a link or a file. */
export interface MetaEvent {
  provider: MetaProvider;
  /** entry.id: the Page id, or the Instagram professional account id. Identifies the business's account. */
  accountId: string;
  /** The customer's opaque page-scoped / Instagram-scoped id. */
  senderId: string;
  eventType: 'message' | 'echo' | 'edit' | 'postback';
  /** The idempotency key: the message id, or a key derived from it. */
  key: string;
  timestamp: Date;
  /** Only for `message`. */
  text: string | null;
  /** Only the kind of each attachment (image, audio, ...). */
  attachmentTypes: string[];
}

export interface ParsedWebhook {
  /** Null when the body is not a Page or Instagram notification at all. */
  object: 'page' | 'instagram' | null;
  events: MetaEvent[];
  /** Things we do not keep at all (deliveries, read receipts, reactions, shapes we do not know). */
  skipped: number;
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const MAX_TEXT = 2000;
const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Read a webhook body that has ALREADY passed the signature check. Never throws: whatever does not look right is skipped.
 * Events of one entry arrive in any order (Meta does not guarantee order): each carries its own timestamp.
 *
 * Decisions: an echo (our own business's reply, which Meta also delivers) is recorded as an event but never read; a postback
 * (a button press) and an edit (Instagram `message_edit`) are recorded and ignored: edits do not re-run extraction because
 * the original message is what the customer sent when they ordered; deliveries, reads and reactions are not stored.
 */
export function parseWebhook(body: unknown): ParsedWebhook {
  const out: ParsedWebhook = { object: null, events: [], skipped: 0 };
  if (!isRec(body)) return out;
  const provider: MetaProvider | null =
    body['object'] === 'page'
      ? 'facebook_page'
      : body['object'] === 'instagram'
        ? 'instagram'
        : null;
  if (!provider) return out;
  out.object = body['object'] as 'page' | 'instagram';
  const entries = Array.isArray(body['entry']) ? body['entry'] : [];
  for (const entry of entries) {
    if (!isRec(entry)) {
      out.skipped++;
      continue;
    }
    const accountId = str(entry['id']);
    const entryTime = typeof entry['time'] === 'number' ? entry['time'] : null;
    const messaging = Array.isArray(entry['messaging']) ? entry['messaging'] : [];
    if (!accountId) {
      out.skipped += Math.max(messaging.length, 1);
      continue;
    }
    for (const m of messaging) {
      if (!isRec(m)) {
        out.skipped++;
        continue;
      }
      const sender = isRec(m['sender']) ? str(m['sender']['id']) : null;
      const recipient = isRec(m['recipient']) ? str(m['recipient']['id']) : null;
      const ts = typeof m['timestamp'] === 'number' ? m['timestamp'] : (entryTime ?? Date.now());
      const timestamp = new Date(Number.isFinite(ts) ? ts : Date.now());
      const message = isRec(m['message']) ? m['message'] : null;
      const edit = isRec(m['message_edit']) ? m['message_edit'] : null;
      const postback = isRec(m['postback']) ? m['postback'] : null;
      if (message) {
        const mid = str(message['mid']);
        if (!mid || !sender || !recipient) {
          out.skipped++;
          continue;
        }
        if (message['is_echo'] === true) {
          // sender is the business, recipient the customer
          out.events.push({
            provider,
            accountId,
            senderId: recipient,
            eventType: 'echo',
            key: mid,
            timestamp,
            text: null,
            attachmentTypes: [],
          });
          continue;
        }
        const text =
          typeof message['text'] === 'string' ? message['text'].slice(0, MAX_TEXT) : null;
        const attachments = Array.isArray(message['attachments']) ? message['attachments'] : [];
        out.events.push({
          provider,
          accountId,
          senderId: sender,
          eventType: 'message',
          key: mid,
          timestamp,
          text: text && text.trim() ? text : null,
          attachmentTypes: attachments
            .map((a) => (isRec(a) ? str(a['type']) : null))
            .filter((t): t is string => t !== null)
            .map((t) => t.slice(0, 20))
            .slice(0, 10),
        });
      } else if (edit) {
        const mid = str(edit['mid']);
        if (!mid || !sender) {
          out.skipped++;
          continue;
        }
        out.events.push({
          provider,
          accountId,
          senderId: sender,
          eventType: 'edit',
          key: `edit:${mid}:${typeof edit['num_edit'] === 'number' ? edit['num_edit'] : 0}`,
          timestamp,
          text: null,
          attachmentTypes: [],
        });
      } else if (postback && sender) {
        const mid = str(postback['mid']);
        out.events.push({
          provider,
          accountId,
          senderId: sender,
          eventType: 'postback',
          key: `postback:${mid ?? `${ts}:${short(String(postback['payload'] ?? ''))}`}`,
          timestamp,
          text: null,
          attachmentTypes: [],
        });
      } else out.skipped++;
    }
  }
  return out;
}
