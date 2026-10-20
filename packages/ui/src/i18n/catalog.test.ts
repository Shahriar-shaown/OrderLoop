import { describe, expect, it } from 'vitest';
import { bn } from './bn';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

describe.each([['ui', bn]])('the Bangla catalogue (%s)', (_name, catalogue) => {
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
