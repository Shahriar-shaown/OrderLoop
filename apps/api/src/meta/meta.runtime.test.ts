import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/config.module.js';
import { MetaRuntime } from './meta.runtime.js';

const runtime = (c: Partial<AppConfig>) =>
  new MetaRuntime({ META_ALLOW_MOCK_IN_PRODUCTION: false, ...c } as AppConfig);

describe('mock endpoints', () => {
  it('exist in mock mode outside production', () => {
    expect(runtime({ NODE_ENV: 'development', META_MODE: 'mock' }).mockEndpointsEnabled).toBe(true);
    expect(runtime({ NODE_ENV: 'test', META_MODE: 'mock' }).mockEndpointsEnabled).toBe(true);
  });
  it('never exist in live mode', () => {
    expect(runtime({ NODE_ENV: 'development', META_MODE: 'live' }).mockEndpointsEnabled).toBe(
      false,
    );
  });
  it('do not exist in production, even in mock mode, without the explicit pilot-demo flag', () => {
    expect(runtime({ NODE_ENV: 'production', META_MODE: 'mock' }).mockEndpointsEnabled).toBe(false);
    expect(
      runtime({
        NODE_ENV: 'production',
        META_MODE: 'mock',
        META_ALLOW_MOCK_IN_PRODUCTION: true,
      }).mockEndpointsEnabled,
    ).toBe(true);
    expect(
      runtime({ NODE_ENV: 'production', META_MODE: 'live', META_ALLOW_MOCK_IN_PRODUCTION: true })
        .mockEndpointsEnabled,
    ).toBe(false);
  });
});
