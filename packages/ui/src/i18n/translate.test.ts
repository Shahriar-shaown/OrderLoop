import { beforeAll, describe, expect, it } from 'vitest';
import { registerCatalog } from './catalog';
import { localizeDateText, localizeDigits } from './dateText';
import { translate } from './translate';

beforeAll(() =>
  registerCatalog('bn', {
    Orders: 'অর্ডার',
    'Showing {a}–{b} of {c} orders': '{c}টির মধ্যে {a}–{b} অর্ডার দেখাচ্ছে',
    '{a} order': '{a}টি অর্ডার',
    '{a} orders': '{a}টি অর্ডার',
  }),
);

describe('translate', () => {
  it('leaves English alone and fills {name} placeholders', () => {
    expect(translate('en', 'Orders')).toBe('Orders');
    expect(translate('en', 'Hi {name}', { name: 'Rina' })).toBe('Hi Rina');
  });

  it('uses an exact entry, then a pattern entry with the matched values carried over', () => {
    expect(translate('bn', 'Orders')).toBe('অর্ডার');
    expect(translate('bn', 'Showing 1–10 of 124 orders')).toBe('১২৪টির মধ্যে ১–১০ অর্ডার দেখাচ্ছে');
    expect(translate('bn', '1 order')).toBe('১টি অর্ডার');
    expect(translate('bn', '30 orders')).toBe('৩০টি অর্ডার');
  });

  it('gives Bengali digits to text without letters, but keeps the digits of codes', () => {
    expect(translate('bn', '৳4,980.00')).toBe('৳৪,৯৮০.০০');
    expect(translate('bn', '93.2%')).toBe('৯৩.২%');
    expect(translate('bn', 'FTP-L-ROSE 12')).toBe('FTP-L-ROSE 12');
  });

  it('shows English for what has no translation rather than nothing', () => {
    expect(translate('bn', 'A sentence nobody translated')).toBe('A sentence nobody translated');
  });
});

describe('dates', () => {
  it('turns month and weekday names, AM/PM and the digits of dates and times into Bangla', () => {
    expect(localizeDateText('Monday, 19 October 2026')).toBe('সোমবার, ১৯ অক্টোবর ২০২৬');
    expect(localizeDateText('Oct 19, 2026, 7:36 PM')).toBe('অক্টোবর ১৯, ২০২৬, ৭:৩৬ অপরাহ্ণ');
    expect(localizeDateText('19 Oct, 19:36')).toBe('১৯ অক্টোবর, ১৯:৩৬');
  });
  it('does not touch ordinary words that look like months', () => {
    expect(localizeDateText('Mark as returned')).toBe('Mark as returned');
    expect(localizeDateText('You may continue')).toBe('You may continue');
  });
  it('converts digits one by one', () => expect(localizeDigits('2026')).toBe('২০২৬'));
});

describe('patterns do not swallow unrelated text', () => {
  it('lets an e-mail address fill a placeholder', () => {
    registerCatalog('bn', { 'Verify ({a}) now please': 'এখনই ({a}) যাচাই করুন' });
    expect(translate('bn', 'Verify (rina@shop.example) now please')).toBe(
      'এখনই (rina@shop.example) যাচাই করুন',
    );
  });
  it('"{a} order" matches a count, not any sentence that ends in "order"', () => {
    expect(translate('bn', 'Confirm this order')).toBe('Confirm this order');
    expect(translate('bn', '3 orders')).toBe('৩টি অর্ডার');
  });
  it('gives Bengali digits to compact amounts like ৳10k', () =>
    expect(translate('bn', '৳10k')).toBe('৳১০k'));
});
