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
  it('treats a malformed percent-encoding as absent instead of throwing', () => {
    expect(readCookie('ol_rt=%E0%A4%A', 'ol_rt')).toBeUndefined();
  });
});
