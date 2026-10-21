import { normalizeBdPhone, type ExtractedDraft, type ExtractedItem } from '@orderloop/contracts';
import { findDistricts } from './bd-districts.js';

/**
 * Turns the messages a customer sent to a business into the fields of a draft order. Pure and deterministic: no network, no
 * model, no randomness. It only looks for things that are safe to find (a phone number, an address line that carries an
 * address word, a quantity next to words that match a catalogue item) and says how sure it is. Whatever it is not sure of is
 * left empty or kept as free text for a person to fix. A price in the chat is never used: prices come from the catalogue.
 */

/** Below this a field or item is shown as "check this" (and `low_confidence_item` is raised). The screens use the same number. */
export const CHECK_THIS_CONFIDENCE = 0.7;

export interface ChatMessage {
  id: string;
  text: string | null;
  at: Date | string | number;
}

export interface CatalogVariant {
  variantId: string;
  sku: string;
  productName: string;
  variantName: string;
}

/** At or above this, a name match is accepted as the item. Below it the text stays a free-text line for the reviewer. */
export const ITEM_MATCH_THRESHOLD = 0.65;
/** The best match must beat the runner-up by this much, otherwise it is ambiguous and nothing is guessed. */
export const ITEM_MATCH_MARGIN = 0.1;

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

function toAsciiDigits(s: string): string {
  return [...s]
    .map((ch) => {
      const i = BANGLA_DIGITS.indexOf(ch);
      return i === -1 ? ch : String(i);
    })
    .join('');
}

/** NFKC, Bangla digits to 0-9, invisible characters removed. Case is kept (the display text); compare with `fold`. */
function clean(s: string): string {
  return toAsciiDigits(s.normalize('NFKC')).replace(/[​-‏‪-‮⁠﻿]/g, '');
}
const fold = (s: string) => clean(s).toLowerCase();
const tokens = (s: string) =>
  fold(s)
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);

// ---- words ------------------------------------------------------------------------------------------------------------

const ORDER_WORDS = [
  'order',
  'অর্ডার',
  'নিব',
  'নিবো',
  'নিমু',
  'চাই',
  'chai',
  'nibo',
  'lagbe',
  'লাগবে',
  'buy',
  'কিনব',
  'কিনবো',
];

const STOPWORDS = new Set(
  (
    'pcs pc piece pieces পিস টা টি ta ti খানা set সেট dozen ডজন order অর্ডার চাই chai নিব নিবো nibo lagbe লাগবে ' +
    'দিবেন দিন dibo dien dan please pls plz want need i me my to a an the of and or for ar আর এবং এই ঐ ' +
    'ভাই আপু bhai vai apu dada sir madam hi hello hey assalamualaikum আসসালামু আলাইকুম জন্য qty quantity পরিমাণ আমি আমার আমাকে ami amake ' +
    'name নাম phone mobile number নম্বর নাম্বার mob price দাম taka tk bdt টাকা ৳ x'
  ).split(' '),
);

const ADDRESS_CUES = [
  'বাসা',
  'রোড',
  'ঠিকানা',
  'থানা',
  'উপজেলা',
  'গ্রাম',
  'বাজার',
  'ফ্ল্যাট',
  'ব্লক',
  'সেক্টর',
  'পোস্ট',
  'মহল্লা',
  'বাড়ি',
  'বাড়ী',
  'হোল্ডিং',
  'address',
  'house',
  'holding',
  'road',
  'rd',
  'thana',
  'upazila',
  'upazilla',
  'village',
  'flat',
  'block',
  'sector',
  'bazar',
  'bazaar',
  'post office',
  'ward',
  'lane',
];
const ADDRESS_CUE_RE = new RegExp(
  `(?<![\\p{L}\\p{M}])(?:${ADDRESS_CUES.map((c) => c.replace(' ', '\\s+')).join('|')})(?![\\p{L}\\p{M}])`,
  'iu',
);

const NUMBER_WORDS: Record<string, number> = {
  এক: 1,
  একটা: 1,
  একটি: 1,
  দুই: 2,
  দুটো: 2,
  দুটি: 2,
  দুইটা: 2,
  তিন: 3,
  তিনটা: 3,
  তিনটি: 3,
  চার: 4,
  চারটা: 4,
  চারটি: 4,
  পাঁচ: 5,
  পাঁচটা: 5,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

const UNIT = '(?:pcs?|pieces?|টা|টি|ta|ti|খানা|পিস|pis|set|সেট|dozen|ডজন)';
/** "2 pcs", "২টা", "x2", "2x", "qty: 3", "quantity 3". */
const QTY_RES: { re: RegExp; dozen?: boolean }[] = [
  { re: new RegExp(`(?<![\\d.])(\\d{1,4})\\s*(?:${UNIT})(?![\\p{L}\\p{M}])`, 'iu') },
  { re: /(?<![\p{L}\p{M}\d])x\s*(\d{1,4})(?!\d)/iu },
  { re: /(?<![\d.])(\d{1,4})\s*x(?![\p{L}\p{M}\d])/iu },
  { re: /(?:qty|quantity|পরিমাণ)\s*[:=\-]?\s*(\d{1,4})(?!\d)/iu },
];
const PRICE_RE = /(?:৳|\btk\b|\btaka\b|\bbdt\b|টাকা|\bprice\b|\bদাম\b)/iu;
// "name: Rina", "নাম: রিনা", and the way people really write in chat: "নাম রিনা", "my name is Rina" (the cue word is not part of the name).
const NAME_RE =
  /(?:^|[\s,;|])(?:name|নাম)(?:\s*[:\-–=]\s*|\s+(?:is\s+|হলো\s+|হল\s+)?)([^\n,;|।]{2,60})/iu;
const NOTE_RE =
  /(?:^|[\s,;|])(?:note|notes|নোট|বিঃদ্রঃ|দ্রষ্টব্য|instruction)\s*[:\-–=]\s*([^\n]{2,300})/iu;
const GREETINGS = new Set([
  'hi',
  'hello',
  'hey',
  'ok',
  'okay',
  'thanks',
  'thank',
  'yes',
  'no',
  'price',
  'available',
  'assalamualaikum',
  'salam',
  'order',
  'আছে',
  'ধন্যবাদ',
  'হ্যাঁ',
  'জি',
]);

// ---- pieces -----------------------------------------------------------------------------------------------------------

interface Segment {
  text: string; // cleaned, case kept
  messageId: string;
  /** True when this segment is the message's own line (not a comma part of it). */
  index: number;
}

/** Lines, then comma-like parts of each line. */
function segmentsOf(message: ChatMessage): Segment[] {
  const text = clean(message.text ?? '');
  const out: Segment[] = [];
  for (const line of text.split(/[\r\n]+/)) {
    for (const part of line.split(/[,;|।]+/)) {
      const t = part.trim();
      if (t) out.push({ text: t, messageId: message.id, index: out.length });
    }
  }
  return out;
}

/** Longest BD number as typed: "00880" + 10 digits. Nothing longer can normalise, so no join needs to be longer. */
const MAX_PHONE_CHARS = 15;
/** A number is never spread over more groups than this ("0 1 7 1 2 3 4 5 6 7 8" is 11, and nobody types that). */
const MAX_PHONE_GROUPS = 12;

/** Most characters of one message that are read. A real order message is far shorter. */
export const MAX_MESSAGE_CHARS = 500;
/** Most characters of one conversation that are read. */
export const MAX_DRAFT_CHARS = 4000;

/** The messages that will be read, with each text capped, in the order given, until the conversation budget is spent. */
function capMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let budget = MAX_DRAFT_CHARS;
  for (const m of messages) {
    if (budget <= 0) break;
    // cap before and after cleaning: normalisation can lengthen a string
    const text = clean((m.text ?? '').slice(0, MAX_MESSAGE_CHARS)).slice(
      0,
      Math.min(MAX_MESSAGE_CHARS, budget),
    );
    budget -= text.length;
    out.push({ ...m, text });
  }
  return out;
}

/**
 * Find a phone number inside text that may contain other numbers next to it ("2 01712 345678"). Linear in the text: a number
 * is at most MAX_PHONE_CHARS characters of at most MAX_PHONE_GROUPS groups, so each start tries a bounded number of joins.
 */
function findPhones(text: string): { phone: string; start: number; end: number }[] {
  const found: { phone: string; start: number; end: number }[] = [];
  const candidate = /\+?\d[\d\s\-().]{7,40}\d/g;
  for (const m of text.matchAll(candidate)) {
    const base = m.index ?? 0;
    // split into groups, remembering where each starts, and take the longest run of groups that is a BD number
    const groups = [...m[0].matchAll(/[\d+]+/g)].map((g) => ({
      s: g[0],
      at: base + (g.index ?? 0),
    }));
    for (let i = 0; i < groups.length;) {
      let raw = '';
      let best: { j: number; phone: string } | null = null;
      for (let j = i; j < groups.length && j - i < MAX_PHONE_GROUPS; j++) {
        raw += groups[j]!.s;
        if (raw.length > MAX_PHONE_CHARS) break;
        const phone = normalizeBdPhone(raw);
        if (phone) best = { j, phone };
      }
      if (best) {
        found.push({
          phone: best.phone,
          start: groups[i]!.at,
          end: groups[best.j]!.at + groups[best.j]!.s.length,
        });
        i = best.j + 1;
      } else i++;
    }
  }
  return found;
}

function removeSpans(text: string, spans: { start: number; end: number }[]): string {
  let out = '';
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, s.start) + ' ';
    at = s.end;
  }
  return (out + text.slice(at)).replace(/\s+/g, ' ').trim();
}

interface Quantity {
  quantity: number;
  /** The text with the quantity phrase taken out. */
  rest: string;
  explicit: boolean;
}

function quantityOf(text: string): Quantity {
  for (const { re } of QTY_RES) {
    const m = re.exec(text);
    if (m) {
      const n = Number(m[1]);
      const dozen = /dozen|ডজন/i.test(m[0]);
      const quantity = Math.min(Math.max(dozen ? n * 12 : n, 1), 10_000);
      return {
        quantity,
        rest: (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length))
          .replace(/\s+/g, ' ')
          .trim(),
        explicit: true,
      };
    }
  }
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const n = NUMBER_WORDS[words[i]!.toLowerCase()];
    if (n !== undefined && (i + 1 < words.length || i > 0)) {
      const rest = words.filter((_, k) => k !== i).join(' ');
      // "এক" / "one" next to other words is a quantity only when something else is left to be the item
      if (tokens(rest).some((t) => !STOPWORDS.has(t))) return { quantity: n, rest, explicit: true };
    }
  }
  // a leading bare number: "2 red tee"
  const lead = /^(\d{1,3})\s+(?=\p{L})/u.exec(text);
  if (lead)
    return { quantity: Number(lead[1]), rest: text.slice(lead[0].length).trim(), explicit: true };
  return { quantity: 1, rest: text, explicit: false };
}

const nameTokens = (s: string) => tokens(s).filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t));

interface Indexed extends CatalogVariant {
  tokens: Set<string>;
  sku: string;
}

function indexCatalog(catalog: readonly CatalogVariant[]): Indexed[] {
  return catalog.map((v) => ({
    ...v,
    tokens: new Set(nameTokens(`${v.productName} ${v.variantName}`)),
  }));
}

function matchVariant(
  text: string,
  catalog: readonly Indexed[],
): { variant: Indexed | null; score: number } {
  const lower = fold(text);
  // 1. SKU, exactly (as its own word, so "TEE-RED-M" in "2 x TEE-RED-M please" matches)
  const words = new Set(
    lower.split(/[\s,;|]+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')),
  );
  const bySku = catalog.find((v) => words.has(v.sku.toLowerCase()));
  if (bySku) return { variant: bySku, score: 1 };
  // 2. normalised name tokens
  const seg = new Set(nameTokens(text));
  if (seg.size === 0) return { variant: null, score: 0 };
  const scored = catalog
    .map((v) => {
      const common = [...seg].filter((t) => v.tokens.has(t)).length;
      if (common === 0 || v.tokens.size === 0) return { v, score: 0 };
      const segCov = common / seg.size;
      const varCov = common / v.tokens.size;
      return { v, score: 0.7 * segCov + 0.3 * varCov };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score === 0) return { variant: null, score: 0 };
  const second = scored[1]?.score ?? 0;
  if (best.score >= ITEM_MATCH_THRESHOLD && best.score - second >= ITEM_MATCH_MARGIN)
    return { variant: best.v, score: Math.min(best.score, 0.95) };
  return { variant: null, score: best.score };
}

const round = (n: number) => Math.round(n * 100) / 100;

// ---- the public functions ---------------------------------------------------------------------------------------------

/** Whether the conversation looks like someone trying to order (a phone number, a catalogue item, or an order word). Chit-chat is not kept. */
export function looksLikeOrder(
  messages: readonly ChatMessage[],
  catalog: readonly CatalogVariant[],
): boolean {
  const texts = capMessages(messages)
    .map((m) => m.text ?? '')
    .filter(Boolean);
  if (texts.some((t) => findPhones(t).length > 0)) return true;
  const lower = texts.map((t) => t.toLowerCase());
  if (lower.some((t) => ORDER_WORDS.some((w) => t.includes(w)))) return true;
  const index = indexCatalog(catalog);
  return texts.some((t) => matchVariant(quantityOf(t).rest, index).variant !== null);
}

/** The draft fields found in `messages` (any order: they are sorted by time), checked against this business's catalogue. */
export function extractDraft(
  messages: readonly ChatMessage[],
  catalog: readonly CatalogVariant[],
): ExtractedDraft {
  const ordered = capMessages(
    [...messages].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()),
  );
  const index = indexCatalog(catalog);
  const draft: ExtractedDraft = { items: [], warnings: [] };
  const warnings = new Set<string>();

  const phones = new Map<string, { n: number; ids: Set<string>; first: number }>();
  const addressParts: { text: string; id: string }[] = [];
  const districtVotes: { name: string; id: string }[] = [];
  const itemByKey = new Map<string, ExtractedItem>();
  const itemOrder: string[] = [];
  let order = 0;

  for (const message of ordered) {
    const whole = clean(message.text ?? '');
    if (!whole) continue;
    const found = findPhones(whole);
    for (const f of found) {
      const e = phones.get(f.phone) ?? { n: 0, ids: new Set<string>(), first: order++ };
      e.n++;
      e.ids.add(message.id);
      phones.set(f.phone, e);
    }
    if (PRICE_RE.test(whole)) warnings.add('price_ignored');

    const nameHit = NAME_RE.exec(whole);
    if (nameHit && !draft.customerName)
      draft.customerName = {
        value: nameHit[1]!.trim(),
        confidence: 0.9,
        sourceEventIds: [message.id],
      };
    const noteHit = NOTE_RE.exec(whole);
    if (noteHit)
      draft.note = { value: noteHit[1]!.trim(), confidence: 0.9, sourceEventIds: [message.id] };

    const segs = segmentsOf(message).map((s) => {
      const spans = findPhones(s.text);
      return { ...s, bare: removeSpans(s.text, spans), hadPhone: spans.length > 0 };
    });
    const cueAt = segs.map((s) => ADDRESS_CUE_RE.test(s.bare) || findDistricts(s.bare).length > 0);
    const first = cueAt.indexOf(true);
    const last = cueAt.lastIndexOf(true);
    const inAddress = new Set<number>();
    if (first >= 0) {
      for (let i = first; i <= last; i++) {
        const s = segs[i]!;
        // a phone-only or name-labelled piece between two address pieces is not part of the address
        if (
          s.bare &&
          !NAME_RE.test(s.text) &&
          !NOTE_RE.test(s.text) &&
          !(s.hadPhone && !cueAt[i])
        ) {
          inAddress.add(i);
          addressParts.push({
            text: s.bare.replace(/^(?:address|ঠিকানা)\s*[:\-–=]?\s*/iu, ''),
            id: message.id,
          });
        }
      }
      for (const dist of findDistricts(
        segs
          .slice(first, last + 1)
          .map((s) => s.bare)
          .join(' '),
      ))
        districtVotes.push({ name: dist.name, id: message.id });
    }

    let namedHere = false;
    segs.forEach((s, i) => {
      if (inAddress.has(i)) return;
      if (NAME_RE.test(s.text) || NOTE_RE.test(s.text)) return;
      const text = s.bare;
      if (!text) return;
      const q = quantityOf(text);
      const m = matchVariant(q.rest, index);
      const rest = q.rest.replace(/\s+/g, ' ').trim();
      if (m.variant) {
        const key = m.variant.variantId;
        const prev = itemByKey.get(key);
        // repeated mention of the same item = a correction, not a second line: the later quantity wins
        const item: ExtractedItem = {
          variantId: key,
          text: rest.slice(0, 300) || m.variant.sku,
          quantity: q.quantity,
          confidence: round(q.explicit ? m.score : Math.min(m.score, 0.85)),
          sourceEventIds: [...new Set([...(prev?.sourceEventIds ?? []), message.id])],
        };
        if (!prev) itemOrder.push(key);
        itemByKey.set(key, item);
      } else if (q.explicit && nameTokens(rest).length > 0 && rest.length >= 2) {
        const key = `text:${fold(rest)}`;
        const prev = itemByKey.get(key);
        if (!prev) itemOrder.push(key);
        itemByKey.set(key, {
          variantId: null,
          text: rest.slice(0, 300),
          quantity: q.quantity,
          confidence: round(Math.min(m.score, 0.5)),
          sourceEventIds: [...new Set([...(prev?.sourceEventIds ?? []), message.id])],
        });
      } else if (
        !namedHere &&
        found.length > 0 &&
        !draft.customerName &&
        !s.hadPhone &&
        /^[\p{L}\p{M}.' -]{2,40}$/u.test(text) &&
        text.split(/\s+/).length <= 4 &&
        !GREETINGS.has(text.toLowerCase()) &&
        !ORDER_WORDS.some((w) => text.toLowerCase().includes(w)) &&
        nameTokens(text).length > 0
      ) {
        // the bare name line of a message that also has a number: a low-confidence guess a person will check
        namedHere = true;
        draft.customerName = { value: text, confidence: 0.5, sourceEventIds: [message.id] };
      }
    });
  }

  if (phones.size > 0) {
    const ranked = [...phones.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first);
    const [phone, info] = ranked[0]!;
    draft.phone = {
      value: phone,
      confidence: phones.size > 1 ? 0.6 : 0.95,
      sourceEventIds: [...info.ids],
    };
    if (phones.size > 1) warnings.add('multiple_phones');
  } else warnings.add('no_phone');

  if (addressParts.length > 0) {
    const seen = new Set<string>();
    const parts = addressParts.filter((p) => {
      const k = fold(p.text);
      if (!p.text || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    draft.address = {
      value: parts
        .map((p) => p.text)
        .join(', ')
        .slice(0, 300),
      confidence: parts.some((p) => ADDRESS_CUE_RE.test(p.text)) ? 0.75 : 0.6,
      sourceEventIds: [...new Set(parts.map((p) => p.id))],
    };
  } else warnings.add('no_address');

  const district = districtVotes.at(-1);
  if (district)
    draft.district = { value: district.name, confidence: 0.8, sourceEventIds: [district.id] };

  draft.items = itemOrder.map((k) => itemByKey.get(k)!).slice(0, 50);
  if (draft.items.length === 0) warnings.add('no_items');
  if (draft.items.some((i) => i.variantId === null)) warnings.add('unmatched_item');
  if (draft.items.some((i) => i.variantId !== null && i.confidence < CHECK_THIS_CONFIDENCE))
    warnings.add('low_confidence_item');

  draft.warnings = [...warnings];
  return draft;
}
