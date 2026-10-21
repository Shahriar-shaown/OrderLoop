import type { OrderSource, SocialDraft, UpdateDraftBody } from '@orderloop/contracts';
import { CHECK_THIS_CONFIDENCE, formatBdPhone } from '@orderloop/domain';
import type { Line } from '../components/orders/OrderLines';
import { variantLabel } from './format';

/** An item the customer asked for that is not mapped to a catalogue product yet: a person picks the product. */
export interface PendingItem {
  text: string;
  quantity: number;
  /** Read from the chat with little confidence. */
  uncertain: boolean;
}

type DraftField =
  'customerName' | 'phone' | 'address' | 'district' | 'area' | 'postalCode' | 'note';

const fieldValue = (draft: SocialDraft, key: DraftField) => draft.fields[key]?.value ?? '';

/** The order form's starting values: what extraction found, with a person's earlier edits on top. */
export function draftFormValues(draft: SocialDraft) {
  const source: OrderSource = draft.mock
    ? 'other'
    : draft.provider === 'instagram'
      ? 'instagram'
      : 'facebook';
  const phone = fieldValue(draft, 'phone');
  const name = fieldValue(draft, 'customerName');
  return {
    phone: phone ? formatBdPhone(phone) : '',
    customerName: name,
    recipientName: name,
    addrPhone: '',
    line1: fieldValue(draft, 'address'),
    area: fieldValue(draft, 'area'),
    district: fieldValue(draft, 'district'),
    division: draft.suggestedDivision ?? 'Dhaka',
    postalCode: fieldValue(draft, 'postalCode'),
    discount: '',
    delivery: '',
    advance: '',
    source: source as string,
    sourceReference: '',
    notes: fieldValue(draft, 'note'),
  };
}

/** The form fields whose value was read from the chat with low confidence and has not been edited by a person. */
export function uncertainFields(draft: SocialDraft): Set<DraftField> {
  const out = new Set<DraftField>();
  for (const key of [
    'customerName',
    'phone',
    'address',
    'district',
    'area',
    'postalCode',
    'note',
  ] as const) {
    const f = draft.fields[key];
    if (f && !f.edited && f.confidence < CHECK_THIS_CONFIDENCE) out.add(key);
  }
  return out;
}

/** The items already mapped to a catalogue product, as order lines priced from the catalogue (the chat's price is never used). */
export function draftLines(draft: SocialDraft): Line[] {
  const lines: Line[] = [];
  for (const item of draft.fields.items) {
    if (!item.variantId || !item.match) continue;
    const label = variantLabel(item.match.productName, item.match.variantName);
    const existing = lines.find((l) => l.variantId === item.variantId);
    if (existing) {
      existing.quantity = String(Number(existing.quantity) + item.quantity);
      continue;
    }
    lines.push({
      variantId: item.variantId,
      sku: item.match.sku,
      label,
      catalogPriceMinor: item.match.priceMinor,
      available: item.match.available,
      reorderPoint: 0,
      costMinor: null,
      quantity: String(item.quantity),
      unitPrice: '',
      discount: '',
      fromChat: { text: item.text, check: !item.edited && item.confidence < CHECK_THIS_CONFIDENCE },
    });
  }
  return lines;
}

export const draftPending = (draft: SocialDraft): PendingItem[] =>
  draft.fields.items
    .filter((i) => !i.variantId || !i.match)
    .map((i) => ({
      text: i.text,
      quantity: i.quantity,
      uncertain: i.confidence < CHECK_THIS_CONFIDENCE,
    }));

type FormValues = ReturnType<typeof draftFormValues>;

/** What to PATCH: only what a person changed since the draft was loaded (a sent key marks it as typed by a person). */
export function draftPatch(
  draft: SocialDraft,
  values: FormValues,
  lines: Line[],
  pending: PendingItem[],
): UpdateDraftBody {
  const start = draftFormValues(draft);
  const patch: UpdateDraftBody = {};
  const text = (v: string) => v.trim();
  if (text(values.customerName) && values.customerName !== start.customerName)
    patch.customerName = text(values.customerName);
  if (text(values.phone) && values.phone !== start.phone) patch.phone = text(values.phone);
  if (text(values.line1) && values.line1 !== start.line1) patch.address = text(values.line1);
  if (text(values.district) && values.district !== start.district)
    patch.district = text(values.district);
  if (text(values.area) && values.area !== start.area) patch.area = text(values.area);
  // The API takes exactly four digits; a half-typed code is the order form's to complain about, not the draft's to save.
  if (/^\d{4}$/.test(text(values.postalCode)) && values.postalCode !== start.postalCode)
    patch.postalCode = text(values.postalCode);
  if (text(values.notes) && values.notes !== start.notes) patch.note = text(values.notes);
  const items: NonNullable<UpdateDraftBody['items']> = [
    ...lines.map((l) => ({
      variantId: l.variantId,
      text: l.label.slice(0, 300),
      quantity: Math.max(1, Math.floor(Number(l.quantity)) || 1),
    })),
    ...pending.map((p) => ({ variantId: null, text: p.text, quantity: p.quantity })),
  ];
  const before = draft.fields.items.map((i) => `${i.variantId ?? ''}|${i.quantity}`).sort();
  const after = items.map((i) => `${i.variantId ?? ''}|${i.quantity}`).sort();
  if (before.join() !== after.join()) patch.items = items;
  return patch;
}
