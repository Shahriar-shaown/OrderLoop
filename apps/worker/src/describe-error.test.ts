import { describe as suite, expect, it } from 'vitest';
import { describe } from './describe-error.js';

suite('describe (worker error line)', () => {
  it('scrubs connection strings, bearer tokens and emails out of the message', () => {
    const err = new Error(
      'connect failed postgres://app_user:hunter2@db.internal:5432/orderloop; Bearer abcdefghijklmnop1234; user a@b.example',
    );
    const line = describe(err);
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('abcdefghijklmnop1234');
    expect(line).not.toContain('a@b.example');
    expect(line).toContain('postgres://[REDACTED]@');
  });
  it('falls back to the code, the inner errors or the name', () => {
    expect(describe(Object.assign(new Error(''), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(
      describe(Object.assign(new Error(''), { errors: [new Error('a'), new Error('b')] })),
    ).toBe('a, b');
    expect(describe(new TypeError(''))).toBe('TypeError');
  });
});
