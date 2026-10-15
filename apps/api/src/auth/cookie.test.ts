import { describe, expect, it } from 'vitest';
import { readCookie } from './auth.controller.js';

describe('readCookie', () => {
  it('finds a cookie among several', () => {
    expect(readCookie('a=1; ol_rt=tok%2Fen; b=2', 'ol_rt')).toBe('tok/en');
  });
  it('returns undefined when absent', () => {
    expect(readCookie(undefined, 'ol_rt')).toBeUndefined();
    expect(readCookie('a=1', 'ol_rt')).toBeUndefined();
  });
});
