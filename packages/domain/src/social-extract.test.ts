import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { divisionOfDistrict, findDistricts } from './bd-districts.js';
import {
  extractDraft,
  looksLikeOrder,
  type CatalogVariant,
  type ChatMessage,
} from './social-extract.js';

const catalog: CatalogVariant[] = [
  { variantId: 'v-red', sku: 'TEE-RED-M', productName: 'Cotton T-Shirt', variantName: 'Red M' },
  { variantId: 'v-blk', sku: 'TEE-BLK-L', productName: 'Cotton T-Shirt', variantName: 'Black L' },
  { variantId: 'v-sandal', sku: 'SHOE-01', productName: 'Leather Sandal', variantName: 'Brown 42' },
  { variantId: 'v-panjabi', sku: 'PANJ-WHT', productName: 'পাঞ্জাবি', variantName: 'সাদা' },
];

let t = 0;
const msg = (text: string | null, id = `m${++t}`, at: number = t * 1000): ChatMessage => ({
  id,
  text,
  at,
});
const one = (text: string) => extractDraft([msg(text, 'only')], catalog);

describe('phone numbers', () => {
  it.each([
    ['my number is 01712345678', '+8801712345678'],
    ['call +8801712345678 please', '+8801712345678'],
    ['8801712345678', '+8801712345678'],
    ['017 1234 5678', '+8801712345678'],
    ['01712-345-678', '+8801712345678'],
    ['মোবাইল: ০১৭১২-৩৪৫৬৭৮', '+8801712345678'],
    ['+৮৮০১৭১২৩৪৫৬৭৮', '+8801712345678'],
  ])('finds %s', (text, expected) => {
    expect(one(text).phone?.value).toBe(expected);
    expect(one(text).phone?.confidence).toBeGreaterThan(0.9);
  });
  it('finds a number glued to a quantity ("2 01712 345678")', () => {
    expect(one('2 01712 345678').phone?.value).toBe('+8801712345678');
  });
  it('ignores things that are not Bangladeshi mobile numbers', () => {
    expect(one('order 12345 and 02-9876543 and 01012345678').phone).toBeUndefined();
    expect(one('order 12345').warnings).toContain('no_phone');
  });
  it('picks the most repeated number and warns when there are several', () => {
    const d = extractDraft(
      [msg('01712345678'), msg('or 01812345678'), msg('yes 01812345678 is better')],
      catalog,
    );
    expect(d.phone?.value).toBe('+8801812345678');
    expect(d.warnings).toContain('multiple_phones');
    expect(d.phone?.confidence).toBeLessThan(0.7);
  });
});

describe('a realistic English order', () => {
  const d = one(
    'Hi\nName: Rahim Uddin\nPhone: 01712-345678\nAddress: House 12, Road 5, Dhanmondi, Dhaka\n2 pcs Cotton T-Shirt Red M',
  );
  it('finds the person, number, address and district', () => {
    expect(d.customerName?.value).toBe('Rahim Uddin');
    expect(d.phone?.value).toBe('+8801712345678');
    expect(d.address?.value).toBe('House 12, Road 5, Dhanmondi, Dhaka');
    expect(d.district?.value).toBe('Dhaka');
  });
  it('maps the line to the catalogue variant with its quantity', () => {
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ variantId: 'v-red', quantity: 2 });
    expect(d.items[0]!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(d.warnings).toEqual([]);
  });
  it('records which message each field came from', () => {
    expect(d.phone?.sourceEventIds).toEqual(['only']);
    expect(d.items[0]!.sourceEventIds).toEqual(['only']);
  });
});

describe('a realistic Bangla order with Bangla digits', () => {
  const d = one(
    'আসসালামু আলাইকুম\nআমি ২টা পাঞ্জাবি সাদা নিব\nনাম: করিম হোসেন\nমোবাইল: ০১৮১২-৩৪৫৬৭৮\nঠিকানা: বাসা ৫, রোড ৩, মিরপুর, ঢাকা',
  );
  it('finds the number, name, address and district in Bangla', () => {
    expect(d.phone?.value).toBe('+8801812345678');
    expect(d.customerName?.value).toBe('করিম হোসেন');
    expect(d.address?.value).toBe('বাসা 5, রোড 3, মিরপুর, ঢাকা');
    expect(d.district?.value).toBe('Dhaka');
  });
  it('matches a Bangla product name and reads ২টা as 2', () => {
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ variantId: 'v-panjabi', quantity: 2 });
  });
});

describe('a mixed Bangla and English one-liner', () => {
  const d = one(
    'Rahim bhai, 01912345678, ২ pcs Leather Sandal Brown 42, House 7 Road 2 Uttara Dhaka',
  );
  it('splits it into its parts', () => {
    expect(d.phone?.value).toBe('+8801912345678');
    expect(d.address?.value).toBe('House 7 Road 2 Uttara Dhaka');
    expect(d.items[0]).toMatchObject({ variantId: 'v-sandal', quantity: 2 });
    expect(d.customerName).toMatchObject({ value: 'Rahim bhai' });
    expect(d.customerName!.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe('addresses', () => {
  it('fills the address only when a line carries an address word or a district', () => {
    const d = one('Rahim 01712345678 2 pcs Cotton T-Shirt Red M');
    expect(d.address).toBeUndefined();
    expect(d.warnings).toContain('no_address');
  });
  it('accepts Bangla district names with an ending (ঢাকায়)', () => {
    const d = one('বাসা ৫ রোড ৩ ঢাকায়');
    expect(d.district?.value).toBe('Dhaka');
    expect(d.address?.value).toContain('ঢাকায়');
  });
  it('does not take the phone or a name line into the address', () => {
    const d = one('Road 4, 01712345678, Name: Abul, Sylhet');
    expect(d.address?.value).toBe('Road 4, Sylhet');
    expect(d.district?.value).toBe('Sylhet');
  });
  it('knows the 64 districts and their divisions', () => {
    expect(findDistricts("Cox's Bazar sadar, Chittagong")).toHaveLength(2);
    expect(divisionOfDistrict('Comilla')).toBe('Chattogram');
    expect(divisionOfDistrict('Narayanganj')).toBe('Dhaka');
    expect(divisionOfDistrict('nowhere')).toBeNull();
  });
});

describe('items and quantities', () => {
  it.each([
    ['2 pcs Cotton T-Shirt Red M', 2],
    ['Cotton T-Shirt Red M x3', 3],
    ['Cotton T-Shirt Red M 4x', 4],
    ['qty: 5 Cotton T-Shirt Red M', 5],
    ['Cotton T-Shirt Red M ৩টা', 3],
    ['1 dozen Cotton T-Shirt Red M', 12],
    ['দুই পিস Cotton T-Shirt Red M', 2],
    ['Cotton T-Shirt Red M', 1],
  ])('reads the quantity in "%s"', (text, quantity) => {
    expect(one(text).items[0]).toMatchObject({ variantId: 'v-red', quantity });
  });
  it('matches a SKU exactly, whatever else is said', () => {
    const d = one('TEE-BLK-L x3 please');
    expect(d.items[0]).toMatchObject({ variantId: 'v-blk', quantity: 3, confidence: 1 });
  });
  it('keeps unknown products as free text for the reviewer, with no variant', () => {
    const d = one('3 pcs blue running shoes');
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ variantId: null, quantity: 3 });
    expect(d.items[0]!.text).toContain('blue running shoes');
    expect(d.warnings).toContain('unmatched_item');
  });
  it('never guesses between two equally good variants', () => {
    const d = one('I want one Cotton T-Shirt');
    expect(d.items[0]!.variantId).toBeNull();
    expect(d.warnings).toContain('unmatched_item');
  });
  it('does not turn chit-chat into items', () => {
    const d = one('hello, is this still available? thanks');
    expect(d.items).toEqual([]);
  });
  it('ignores prices said in the chat and says so', () => {
    const d = one('2 pcs Cotton T-Shirt Red M 500 tk each');
    expect(d.items[0]).toMatchObject({ variantId: 'v-red', quantity: 2 });
    expect(d.codAmountMinor).toBeUndefined();
    expect(d.warnings).toContain('price_ignored');
    expect(JSON.stringify(d)).not.toContain('50000');
  });
  it('lets a later mention of the same item correct the quantity instead of adding a line', () => {
    const d = extractDraft(
      [
        msg('2 pcs Cotton T-Shirt Red M', 'a', 1000),
        msg('sorry, 3 pcs Cotton T-Shirt Red M', 'b', 2000),
      ],
      catalog,
    );
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ quantity: 3 });
    expect(d.items[0]!.sourceEventIds).toEqual(['a', 'b']);
  });
});

describe('several messages', () => {
  it('combines a conversation, whatever order the messages arrive in', () => {
    const messages = [
      msg('Road 5, Mirpur, Dhaka', 'c', 3000),
      msg('2 pcs Cotton T-Shirt Red M', 'a', 1000),
      msg('01712345678', 'b', 2000),
    ];
    const d = extractDraft(messages, catalog);
    expect(d.phone).toMatchObject({ value: '+8801712345678', sourceEventIds: ['b'] });
    expect(d.address?.sourceEventIds).toEqual(['c']);
    expect(d.items[0]!.sourceEventIds).toEqual(['a']);
    expect(extractDraft([...messages].reverse(), catalog)).toEqual(d);
  });
  it('copes with attachment-only and empty messages', () => {
    const d = extractDraft([msg(null), msg(''), msg('01712345678')], catalog);
    expect(d.phone?.value).toBe('+8801712345678');
  });
});

describe('looksLikeOrder (what is kept at all)', () => {
  it.each([
    ['01712345678', true],
    ['আমি অর্ডার করতে চাই', true],
    ['I want to order', true],
    ['ami nibo', true],
    ['SHOE-01', true],
    ['2 pcs Leather Sandal Brown 42', true],
    ['hi', false],
    ['price koto?', false],
    ['thanks, will tell my friend', false],
    ['', false],
  ])('%j -> %s', (text, expected) => {
    expect(looksLikeOrder([msg(text)], catalog)).toBe(expected);
  });
});

describe('robustness', () => {
  it('never throws and only produces valid numbers, whatever it is given', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 300 }), { maxLength: 6 }), (texts) => {
        const d = extractDraft(
          texts.map((x) => msg(x)),
          catalog,
        );
        if (d.phone) expect(d.phone.value).toMatch(/^\+8801[3-9]\d{8}$/);
        for (const i of d.items) {
          expect(i.quantity).toBeGreaterThanOrEqual(1);
          expect(i.quantity).toBeLessThanOrEqual(10_000);
        }
        looksLikeOrder(
          texts.map((x) => msg(x)),
          catalog,
        );
      }),
      { numRuns: 200 },
    );
  });
  it('is deterministic', () => {
    const m = [msg('Name: A B\n01712345678\nHouse 1, Dhaka\n2 pcs TEE-RED-M')];
    expect(extractDraft(m, catalog)).toEqual(extractDraft(m, catalog));
  });
});

// The cubic parser took several seconds on these inputs; a ceiling this far above the fixed code's few milliseconds still fails on a
// regression, and does not fail on a slow, shared CI runner (an earlier 50 ms limit measured 70 ms there).
const LIMIT_MS = 500;

describe('bounded work on hostile text', () => {
  /** Best of five after a warm-up: a busy CI machine slows a run down, it does not make cubic work look linear. */
  const time = (fn: () => void) => {
    fn();
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const spaced = Array.from({ length: 1000 }, (_, i) => String(i % 10)).join(' '); // 2,000 chars
  const repeated = '01712 '.repeat(400); // 2,400 chars
  const joined = '12345678'.repeat(500); // 4,000 chars
  it.each([
    ['spaced digits', spaced],
    ['"01712 " repeated', repeated],
    ['one long digit run', joined],
    ['dashes between digits', '1-'.repeat(1000)],
  ])('extractDraft and looksLikeOrder stay fast on %s', (_name, text) => {
    expect(time(() => extractDraft([msg(text)], catalog))).toBeLessThan(LIMIT_MS);
    expect(time(() => looksLikeOrder([msg(text)], catalog))).toBeLessThan(LIMIT_MS);
  });
  it('stays fast over many messages that together are huge', () => {
    const many = Array.from({ length: 2000 }, () => msg(repeated));
    expect(time(() => extractDraft(many, catalog))).toBeLessThan(LIMIT_MS);
  });
  it('still reads a number inside the per-message cap and ignores text beyond it', () => {
    expect(one(`${'x '.repeat(100)} 01712345678`).phone?.value).toBe('+8801712345678');
    expect(one(`${'x '.repeat(400)} 01712345678`).phone).toBeUndefined();
  });
  it('reads the 00880 form (the longest accepted)', () => {
    expect(one('008801712345678').phone?.value).toBe('+8801712345678');
  });
});

describe('customer name written the way people write in chat', () => {
  const nameOf = (text: string) => one(text).customerName?.value;
  it.each([
    ['আমি ২টা শার্ট নিব, নাম রিনা, ০১৭১২৩৪৫৬৭৮', 'রিনা'],
    ['নাম: রিনা আক্তার, 01712345678', 'রিনা আক্তার'],
    ['my name is Rina Akter, 01712345678', 'Rina Akter'],
    ['name Rina, 01712345678', 'Rina'],
  ])('reads the name in %j without the cue word', (text, name) => {
    expect(nameOf(text)).toBe(name);
  });
});
