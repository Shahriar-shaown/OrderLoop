import type { ExtractedDraft, ExtractedItem } from '@orderloop/contracts';

/** What a person typed over the extraction. Wins over it and survives a new message arriving. */
export interface DraftOverrides {
  customerName?: string;
  phone?: string;
  address?: string;
  district?: string;
  area?: string;
  postalCode?: string;
  note?: string;
  codAmountMinor?: number;
  items?: { variantId: string | null; text: string; quantity: number }[];
}

export const TEXT_FIELDS = [
  'customerName',
  'phone',
  'address',
  'district',
  'area',
  'postalCode',
  'note',
] as const;

export interface EffectiveField<T> {
  value: T;
  confidence: number;
  sourceEventIds: string[];
  edited: boolean;
}
export type EffectiveItem = ExtractedItem & { edited: boolean };
export interface EffectiveDraft {
  customerName?: EffectiveField<string>;
  phone?: EffectiveField<string>;
  address?: EffectiveField<string>;
  district?: EffectiveField<string>;
  area?: EffectiveField<string>;
  postalCode?: EffectiveField<string>;
  note?: EffectiveField<string>;
  codAmountMinor?: EffectiveField<number>;
  items: EffectiveItem[];
}

/** An edit counts as certain (confidence 1): a person looked at it. */
export function effectiveDraft(
  extracted: Partial<ExtractedDraft> | null | undefined,
  overrides: DraftOverrides | null | undefined,
): EffectiveDraft {
  const e = extracted ?? {};
  const o = overrides ?? {};
  const out: EffectiveDraft = { items: [] };
  for (const key of TEXT_FIELDS) {
    const edited = o[key];
    const found = e[key];
    if (edited !== undefined)
      out[key] = { value: edited, confidence: 1, sourceEventIds: [], edited: true };
    else if (found) out[key] = { ...found, edited: false };
  }
  if (o.codAmountMinor !== undefined)
    out.codAmountMinor = {
      value: o.codAmountMinor,
      confidence: 1,
      sourceEventIds: [],
      edited: true,
    };
  else if (e.codAmountMinor) out.codAmountMinor = { ...e.codAmountMinor, edited: false };
  out.items = o.items
    ? o.items.map((i) => ({
        variantId: i.variantId,
        text: i.text,
        quantity: i.quantity,
        confidence: 1,
        sourceEventIds: [],
        edited: true,
      }))
    : (e.items ?? []).map((i) => ({ ...i, edited: false }));
  return out;
}

/** Plain-language reasons, by code. The screens translate by code; this is the fallback sentence. */
export const WARNING_TEXT: Record<string, string> = {
  no_phone: 'No phone number was found in the messages.',
  multiple_phones: 'More than one phone number was found. Check which one to use.',
  no_address: 'No address was found. Ask the customer or type it in.',
  no_items: 'No product was recognised. Add the items by hand.',
  unmatched_item:
    'Some items could not be matched to your catalogue. Choose the right product for each.',
  low_confidence_item: 'Some items were matched with low confidence. Check them.',
  price_ignored:
    'A price was mentioned in the chat. It is ignored: prices come from your catalogue.',
  duplicate_order: 'A similar recent order exists. Check it is not a repeat.',
};
