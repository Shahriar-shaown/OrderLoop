import { describe, expect, it } from 'vitest';
import { normalizeBdPhone } from './phone.js';

describe('normalizeBdPhone', () => {
  it('reads the usual spellings', () => {
    for (const input of ['01712-345678', '+8801712345678', '8801712345678', '০১৭১২৩৪৫৬৭৮'])
      expect(normalizeBdPhone(input)).toBe('+8801712345678');
  });
  it('ignores direction marks and any kind of dash from a pasted number', () => {
    expect(normalizeBdPhone('‪+880 1712‑345678‬')).toBe('+8801712345678'); // LRE, non-breaking hyphen, PDF
    expect(normalizeBdPhone('‎01712−345678‏')).toBe('+8801712345678'); // LRM, minus sign, RLM
    expect(normalizeBdPhone('01712–345678')).toBe('+8801712345678'); // en dash
  });
  it('still refuses what is not a mobile number', () => {
    expect(normalizeBdPhone('‪0171234‬')).toBeNull();
    expect(normalizeBdPhone('01212345678')).toBeNull();
  });
});
