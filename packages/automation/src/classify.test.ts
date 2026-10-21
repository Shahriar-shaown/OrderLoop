import { describe, expect, it } from 'vitest';
import { DeliveryError, classifyError, scrubError } from './classify.js';
import { jobIdOf } from './jobs.js';

describe('classifyError (retry classification)', () => {
  it('SMTP: 5xx is permanent (the address or content is refused), 4xx is transient', () => {
    expect(classifyError(Object.assign(new Error('no such user'), { responseCode: 550 }))).toEqual({
      permanent: true,
      reason: 'invalid_recipient',
    });
    expect(
      classifyError(Object.assign(new Error('try later'), { responseCode: 451 })).permanent,
    ).toBe(false);
  });
  it('HTTP: 4xx is permanent except 408 and 429; 5xx is transient', () => {
    expect(classifyError({ status: 400 }).permanent).toBe(true);
    expect(classifyError({ status: 401 }).permanent).toBe(true);
    expect(classifyError({ status: 404 }).permanent).toBe(true);
    expect(classifyError({ status: 408 }).permanent).toBe(false);
    expect(classifyError({ status: 429 })).toEqual({ permanent: false, reason: 'rate_limited' });
    expect(classifyError({ status: 500 }).permanent).toBe(false);
    expect(classifyError({ status: 503 }).permanent).toBe(false);
  });
  it('timeouts and network errors are transient, and so is anything unknown (a lost send is worse than a late one)', () => {
    expect(classifyError(Object.assign(new Error('x'), { name: 'TimeoutError' })).permanent).toBe(
      false,
    );
    expect(classifyError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).permanent).toBe(
      false,
    );
    expect(classifyError(new Error('???')).permanent).toBe(false);
    expect(classifyError(null).permanent).toBe(false);
  });
  it('an explicit DeliveryError says for itself', () => {
    expect(classifyError(new DeliveryError('x', true, 'no_consent'))).toEqual({
      permanent: true,
      reason: 'no_consent',
    });
    expect(classifyError(new DeliveryError('x', false, 'busy')).permanent).toBe(false);
  });
});

describe('scrubError', () => {
  it('removes addresses, tokens, numbers and long secrets, and is short', () => {
    const out = scrubError(
      new Error(
        'could not deliver to rahim@example.test token ExponentPushToken[abcDEF123] phone +8801712345678 key ' +
          'a'.repeat(60) +
          ' ' +
          'x'.repeat(500),
      ),
    );
    expect(out).not.toMatch(/rahim|ExponentPushToken\[abc|8801712345678|aaaaaaaaaaaaaaaaaaaa/);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain('[email]');
  });
});

describe('jobIdOf', () => {
  it('is deterministic and never contains a colon (BullMQ refuses them)', () => {
    const rule = '0197b0a0-0000-7000-8000-000000000001';
    expect(jobIdOf(rule, 'scan:20261025T1430Z')).toBe(`${rule}__scan_20261025T1430Z`);
    expect(jobIdOf(rule, 'daily:2026-03-29')).toBe(jobIdOf(rule, 'daily:2026-03-29'));
    expect(jobIdOf('neworder', rule)).not.toContain(':');
    expect(jobIdOf('a', 1)).toBe('a__1');
  });
});
