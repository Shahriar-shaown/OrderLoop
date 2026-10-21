import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_KINDS,
  DEFAULT_RULE_CONFIG,
  RuleConfig,
  UpdateMessagingConsentBody,
  parseRuleConfig,
  PushToken,
} from './automation.js';
import { ERROR_STATUS } from './errors.js';

describe('rule configuration schemas', () => {
  it('every kind has a default config that validates for that kind', () => {
    for (const kind of AUTOMATION_KINDS) {
      const r = parseRuleConfig(kind, DEFAULT_RULE_CONFIG[kind]);
      expect(r.ok, kind).toBe(true);
    }
  });
  it('is a discriminated union on kind', () => {
    expect(RuleConfig.safeParse({ kind: 'NEW_ORDER' }).success).toBe(true);
    expect(RuleConfig.safeParse({ kind: 'NOPE' }).success).toBe(false);
  });
  it('LOW_STOCK: fixed needs a quantity; the basis is one of two', () => {
    expect(parseRuleConfig('LOW_STOCK', { basis: 'fixed', includeZeroStock: true }).ok).toBe(false);
    expect(
      parseRuleConfig('LOW_STOCK', { basis: 'fixed', fixedQuantity: 3, includeZeroStock: false })
        .ok,
    ).toBe(true);
    expect(parseRuleConfig('LOW_STOCK', { basis: 'percent', includeZeroStock: true }).ok).toBe(
      false,
    );
    expect(parseRuleConfig('LOW_STOCK', { basis: 'reorder_point' }).ok).toBe(false); // includeZeroStock is required
    expect(
      parseRuleConfig('LOW_STOCK', { basis: 'fixed', fixedQuantity: -1, includeZeroStock: true })
        .ok,
    ).toBe(false);
  });
  it('UNCONFIRMED_ORDER: 5 to 10080 minutes, optional repeat', () => {
    for (const afterMinutes of [4, 10081, 1.5, '60'])
      expect(parseRuleConfig('UNCONFIRMED_ORDER', { afterMinutes }).ok, String(afterMinutes)).toBe(
        false,
      );
    expect(parseRuleConfig('UNCONFIRMED_ORDER', { afterMinutes: 5 }).ok).toBe(true);
    expect(
      parseRuleConfig('UNCONFIRMED_ORDER', { afterMinutes: 10080, repeatEveryMinutes: 30 }).ok,
    ).toBe(true);
    expect(
      parseRuleConfig('UNCONFIRMED_ORDER', { afterMinutes: 60, repeatEveryMinutes: 1 }).ok,
    ).toBe(false);
  });
  it('DELAYED_ORDER: 1 to 720 hours', () => {
    for (const afterHours of [0, 721, 0.5])
      expect(parseRuleConfig('DELAYED_ORDER', { afterHours }).ok).toBe(false);
    expect(parseRuleConfig('DELAYED_ORDER', { afterHours: 720 }).ok).toBe(true);
  });
  it('COD_DISCREPANCY: optional non-negative integer minimum', () => {
    expect(parseRuleConfig('COD_DISCREPANCY', {}).ok).toBe(true);
    expect(parseRuleConfig('COD_DISCREPANCY', { minAmountMinor: 5000 }).ok).toBe(true);
    expect(parseRuleConfig('COD_DISCREPANCY', { minAmountMinor: -1 }).ok).toBe(false);
  });
  it('reports: HH:mm in 24 hours, weekday 0 to 6', () => {
    for (const localTime of ['24:00', '9:00', '09:60', '', 'ab:cd'])
      expect(parseRuleConfig('DAILY_REPORT', { localTime }).ok, localTime).toBe(false);
    expect(parseRuleConfig('DAILY_REPORT', { localTime: '00:00' }).ok).toBe(true);
    expect(parseRuleConfig('DAILY_REPORT', { localTime: '23:59' }).ok).toBe(true);
    expect(parseRuleConfig('WEEKLY_REPORT', { localTime: '09:00', weekday: 7 }).ok).toBe(false);
    expect(parseRuleConfig('WEEKLY_REPORT', { localTime: '09:00', weekday: 6 }).ok).toBe(true);
    expect(parseRuleConfig('WEEKLY_REPORT', { localTime: '09:00' }).ok).toBe(false);
  });
  it('drops unknown keys, never lets the body change the kind, and reports paths relative to the config', () => {
    const r = parseRuleConfig('DELAYED_ORDER', { afterHours: 5, kind: 'LOW_STOCK', extra: 1 });
    expect(r).toEqual({ ok: true, config: { afterHours: 5 } });
    const bad = parseRuleConfig('UNCONFIRMED_ORDER', { afterMinutes: 1 });
    expect(bad.ok === false && bad.issues[0]!.path).toBe('afterMinutes');
  });
});

describe('consent and tokens', () => {
  it('granting needs a phone number; revoking does not', () => {
    expect(UpdateMessagingConsentBody.safeParse({ channel: 'sms', granted: true }).success).toBe(
      false,
    );
    expect(
      UpdateMessagingConsentBody.safeParse({ channel: 'sms', granted: true, phone: '01712345678' })
        .success,
    ).toBe(true);
    expect(
      UpdateMessagingConsentBody.safeParse({ channel: 'whatsapp', granted: false }).success,
    ).toBe(true);
    expect(UpdateMessagingConsentBody.safeParse({ channel: 'email', granted: false }).success).toBe(
      false,
    );
  });
  it('a push token is a path-safe string', () => {
    expect(PushToken.safeParse('ExponentPushToken[abc-DEF_123]').success).toBe(true);
    for (const bad of ['short', 'has space token', 'a/b/c/d/e/f/g', 'x'.repeat(513)])
      expect(PushToken.safeParse(bad).success, bad).toBe(false);
  });
  it('the new error codes are 422', () => {
    expect(ERROR_STATUS.channel_not_configured).toBe(422);
    expect(ERROR_STATUS.consent_required).toBe(422);
  });
});
