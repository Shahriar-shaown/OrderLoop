import { describe, expect, it } from 'vitest';
import { stable } from './stable.js';

describe('stable', () => {
  it('gives the same text whatever the key order, and skips undefined', () => {
    expect(stable({ b: 1, a: [{ d: 1, c: undefined }] })).toBe(stable({ a: [{ d: 1 }], b: 1 }));
  });
  it('orders keys by code point, not by locale', () => {
    // localeCompare would put "a" before "B" and "é" between "e" and "f"; code points put uppercase first and "é" last.
    expect(stable({ a: 1, B: 2, é: 3, f: 4 })).toBe('{"B":2,"a":1,"f":4,"é":3}');
  });
});
