import { describe, expect, it } from 'vitest';
import { parseRevokeArgs } from './revoke-sessions.js';

describe('parseRevokeArgs', () => {
  it('takes exactly one scope', () => {
    expect(parseRevokeArgs(['--all'])).toEqual({ scope: { kind: 'all' }, yes: false });
    expect(parseRevokeArgs(['--user', 'A@b.test', '--yes'])).toEqual({
      scope: { kind: 'user', email: 'A@b.test' },
      yes: true,
    });
    expect(parseRevokeArgs(['--tenant', 'abc'])).toMatchObject({ scope: { kind: 'tenant' } });
    expect(() => parseRevokeArgs([])).toThrow(/exactly one/);
    expect(() => parseRevokeArgs(['--all', '--user', 'a@b.test'])).toThrow(/exactly one/);
    expect(() => parseRevokeArgs(['--user'])).toThrow(/needs a value/);
    expect(() => parseRevokeArgs(['--nope'])).toThrow(/Unknown/);
  });
});
