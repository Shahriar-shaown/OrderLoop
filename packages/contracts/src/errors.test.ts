import { describe, expect, it } from 'vitest';
import { isKnownErrorCode, Problem } from './errors.js';

describe('Problem', () => {
  const base = { type: 'about:blank', title: 'Nope', status: 409, detail: 'Try again' };
  it('keeps a problem whose code this build does not know, so message and status survive', () => {
    const parsed = Problem.safeParse({ ...base, code: 'brand_new_code' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ code: 'brand_new_code', detail: 'Try again', status: 409 });
  });
  it('tells known codes from unknown ones', () => {
    expect(isKnownErrorCode('token_expired')).toBe(true);
    expect(isKnownErrorCode('brand_new_code')).toBe(false);
    expect(isKnownErrorCode(undefined)).toBe(false);
  });
});
