import { AUTOMATION_KINDS, DEFAULT_RULE_CONFIG, parseRuleConfig } from '@orderloop/contracts';
import { describe, expect, it } from 'vitest';
import { CONFIG_FIELDS, fromDraft, toDraft } from './automation';

describe('rule settings as a form', () => {
  it('starts from the defaults and gives back the same settings', () => {
    for (const kind of AUTOMATION_KINDS) {
      const result = fromDraft(kind, toDraft(kind, DEFAULT_RULE_CONFIG[kind]));
      expect(result, kind).toEqual({
        ok: true,
        config: expect.objectContaining(DEFAULT_RULE_CONFIG[kind]),
      });
    }
  });

  it('keeps the limits of the contract: the edges are accepted and one past them is refused', () => {
    for (const kind of AUTOMATION_KINDS) {
      const base = DEFAULT_RULE_CONFIG[kind] as Record<string, unknown>;
      for (const f of CONFIG_FIELDS[kind]) {
        if (f.type === 'number') {
          for (const ok of [f.min, f.max])
            expect(parseRuleConfig(kind, { ...base, basis: 'fixed', [f.key]: ok }).ok, f.key).toBe(
              true,
            );
          expect(parseRuleConfig(kind, { ...base, basis: 'fixed', [f.key]: f.max + 1 }).ok).toBe(
            false,
          );
          if (f.min > 0)
            expect(parseRuleConfig(kind, { ...base, [f.key]: f.min - 1 }).ok, f.key).toBe(false);
        }
        if (f.type === 'money') {
          expect(parseRuleConfig(kind, { [f.key]: f.maxTaka * 100 }).ok).toBe(true);
          expect(parseRuleConfig(kind, { [f.key]: f.maxTaka * 100 + 1 }).ok).toBe(false);
        }
      }
    }
  });

  it('explains a number outside its limits in words, naming the limits', () => {
    const draft = { ...toDraft('UNCONFIRMED_ORDER', {}), afterMinutes: '3' };
    expect(fromDraft('UNCONFIRMED_ORDER', draft)).toEqual({
      ok: false,
      errors: { afterMinutes: 'Enter a whole number from 5 to 10080.' },
    });
    for (const bad of ['', 'abc', '5.5', '-5', '10081'])
      expect(fromDraft('UNCONFIRMED_ORDER', { ...draft, afterMinutes: bad }).ok, bad).toBe(false);
    expect(fromDraft('UNCONFIRMED_ORDER', { ...draft, afterMinutes: ' 90 ' })).toMatchObject({
      ok: true,
      config: { afterMinutes: 90 },
    });
  });

  it('leaves out an optional number that is empty, and keeps one that is typed', () => {
    const draft = toDraft('UNCONFIRMED_ORDER', { afterMinutes: 60 });
    expect(fromDraft('UNCONFIRMED_ORDER', draft)).toEqual({
      ok: true,
      config: { afterMinutes: 60 },
    });
    expect(fromDraft('UNCONFIRMED_ORDER', { ...draft, repeatEveryMinutes: '30' })).toEqual({
      ok: true,
      config: { afterMinutes: 60, repeatEveryMinutes: 30 },
    });
  });

  it('asks for the fixed quantity only when the basis is fixed', () => {
    const draft = toDraft('LOW_STOCK', { basis: 'reorder_point', includeZeroStock: false });
    expect(fromDraft('LOW_STOCK', draft)).toEqual({
      ok: true,
      config: { basis: 'reorder_point', includeZeroStock: false },
    });
    expect(fromDraft('LOW_STOCK', { ...draft, basis: 'fixed' })).toMatchObject({
      ok: false,
      errors: { fixedQuantity: 'Enter a whole number from 0 to 1000000.' },
    });
    expect(fromDraft('LOW_STOCK', { ...draft, basis: 'fixed', fixedQuantity: '4' })).toEqual({
      ok: true,
      config: { basis: 'fixed', fixedQuantity: 4, includeZeroStock: false },
    });
  });

  it('checks the report time (24 hours) and sends the weekday as a number', () => {
    const draft = toDraft('WEEKLY_REPORT', { localTime: '09:00', weekday: 5 });
    expect(draft).toEqual({ localTime: '09:00', weekday: '5' });
    expect(fromDraft('WEEKLY_REPORT', draft)).toEqual({
      ok: true,
      config: { localTime: '09:00', weekday: 5 },
    });
    for (const bad of ['9:00', '24:00', '09:60', '', 'noon'])
      expect(fromDraft('WEEKLY_REPORT', { ...draft, localTime: bad }), bad).toEqual({
        ok: false,
        errors: { localTime: 'Use 24-hour time such as 20:00.' },
      });
  });

  it('shows the smallest COD difference in taka and stores it in paisa', () => {
    expect(toDraft('COD_DISCREPANCY', { minAmountMinor: 12550 })).toEqual({
      minAmountMinor: '125.5',
    });
    expect(fromDraft('COD_DISCREPANCY', { minAmountMinor: '125.50' })).toEqual({
      ok: true,
      config: { minAmountMinor: 12550 },
    });
    expect(fromDraft('COD_DISCREPANCY', { minAmountMinor: '' })).toEqual({ ok: true, config: {} });
    expect(fromDraft('COD_DISCREPANCY', { minAmountMinor: '1.234' }).ok).toBe(false);
  });
});
