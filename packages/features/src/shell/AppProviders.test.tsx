import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/mount';
import { formatShortDay, setFormatLocale } from '../lib/format';

describe('AppProviders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setFormatLocale('en');
  });

  it('gives the chosen language to the date formatters', () => {
    expect(formatShortDay('2026-10-17')).toBe('17 Oct');
    vi.stubEnv('TEST_LOCALE', 'bn'); // mount() starts the app in Bangla
    mount(<span />, {});
    expect(formatShortDay('2026-10-17')).toContain('১৭');
  });
});
