import { describe, expect, it } from 'vitest';
import { effectiveDraft } from './draft-view.js';

const found = {
  phone: { value: '+8801712345678', confidence: 0.95, sourceEventIds: ['e1'] },
  address: { value: 'Road 5, Dhaka', confidence: 0.75, sourceEventIds: ['e2'] },
  items: [
    { variantId: null, text: 'blue shoes', quantity: 2, confidence: 0.3, sourceEventIds: ['e2'] },
  ],
  warnings: ['unmatched_item'],
};

describe('effectiveDraft', () => {
  it('is what was found when nothing was edited', () => {
    const d = effectiveDraft(found, {});
    expect(d.phone).toEqual({ ...found.phone, edited: false });
    expect(d.items).toEqual([{ ...found.items[0]!, edited: false }]);
    expect(d.customerName).toBeUndefined();
  });
  it('lets an edit win, with full confidence, and keeps what was not edited', () => {
    const d = effectiveDraft(found, { phone: '+8801812345678', customerName: 'Rahim' });
    expect(d.phone).toMatchObject({ value: '+8801812345678', confidence: 1, edited: true });
    expect(d.customerName).toMatchObject({ value: 'Rahim', edited: true });
    expect(d.address).toMatchObject({ value: 'Road 5, Dhaka', edited: false });
  });
  it('replaces the whole item list when it was edited', () => {
    const d = effectiveDraft(found, { items: [{ variantId: 'v1', text: 'Red tee', quantity: 1 }] });
    expect(d.items).toEqual([
      {
        variantId: 'v1',
        text: 'Red tee',
        quantity: 1,
        confidence: 1,
        sourceEventIds: [],
        edited: true,
      },
    ]);
  });
  it('treats area and postal code as editable fields', () => {
    const d = effectiveDraft(found, { area: 'Dhanmondi', postalCode: '1209' });
    expect(d.area).toMatchObject({ value: 'Dhanmondi', confidence: 1, edited: true });
    expect(d.postalCode).toMatchObject({ value: '1209', edited: true });
    expect(effectiveDraft(found, {}).area).toBeUndefined();
  });
  it('copes with an empty draft', () => {
    expect(effectiveDraft(undefined, undefined)).toEqual({ items: [] });
  });
});
