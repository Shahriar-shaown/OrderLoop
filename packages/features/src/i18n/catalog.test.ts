import { translate } from '@orderloop/ui';
import { describe, expect, it } from 'vitest';
import './index';
import { bn as features } from './bn';
import { bnAutomation } from './bn.automation';
import { bnExtra } from './bn.extra';
import { bnMeta } from './bn.meta';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

describe.each([
  ['features', features],
  ['features (mobile shell)', bnExtra],
  ['features (automation)', bnAutomation],
  ['features (Meta integration)', bnMeta],
])('the Bangla catalogue (%s)', (_name, catalogue) => {
  const entries = Object.entries(catalogue);

  it('has entries', () => expect(entries.length).toBeGreaterThan(0));

  it('has a Bangla value for every key', () => {
    for (const [key, value] of entries) {
      expect(value.trim(), key).not.toBe('');
      // COD-style abbreviations aside, a translation contains Bengali script.
      if (!/^[A-Z0-9 ()·&/.-]+$/.test(value)) expect(value, key).toMatch(/[ঀ-৿]/);
    }
  });

  it('carries every {placeholder} of the key into the value, and nothing else', () => {
    for (const [key, value] of entries)
      expect([...placeholders(value)].sort(), key).toEqual([...placeholders(key)].sort());
  });

  it('never repeats a placeholder name in one key (the matched pieces could not be told apart)', () => {
    for (const [key] of entries) {
      const names = placeholders(key);
      expect(new Set(names).size, key).toBe(names.length);
    }
  });
});

describe('texts built at run time for returns, closing and booking', () => {
  const bangla = (text: string) => translate('bn', text);
  it.each([
    'Returned: TEE-1',
    'Condition: TEE-1',
    '2 sent',
    'Only an owner, admin or manager can mark an order delivered or returned by hand.',
    'This order cannot be booked with a courier',
    '3 order(s) returned in this period came back only in part. They are not revenue, and the units the customer kept are in neither revenue nor cost of goods, so profit may be overstated by their cost.',
    '2 delivered order(s) with COD have no real courier shipment, so no statement can ever confirm their cash. They are not in outstanding COD.',
  ])('translates %s', (text) => expect(bangla(text)).not.toBe(text));
  it('keeps the quantities of a return summary in order', () => {
    expect(bangla('1 of 2')).toMatch(/[ঀ-৿]/);
  });
});
