import { TikTokApiError } from '@orderloop/automation';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/config.module.js';
import { TikTokRuntime, tiktokProblem } from './tiktok.runtime.js';

const base = {
  TIKTOK_ALLOW_MOCK_IN_PRODUCTION: false,
  TIKTOK_AUTH_HOST: 'https://auth.example.test',
  TIKTOK_API_HOST: 'https://api.example.test',
  TIKTOK_API_VERSION: '202309',
  API_PORT: 4000,
  WEB_ORIGINS: ['http://localhost:3000'],
};
const runtime = (c: Partial<AppConfig>) => new TikTokRuntime({ ...base, ...c } as AppConfig);

describe('mock endpoints', () => {
  it('exist in mock mode outside production', () => {
    expect(runtime({ NODE_ENV: 'development', TIKTOK_MODE: 'mock' }).mockEndpointsEnabled).toBe(
      true,
    );
    expect(runtime({ NODE_ENV: 'test', TIKTOK_MODE: 'mock' }).mockEndpointsEnabled).toBe(true);
  });
  it('never exist in live mode', () => {
    expect(runtime({ NODE_ENV: 'development', TIKTOK_MODE: 'live' }).mockEndpointsEnabled).toBe(
      false,
    );
  });
  it('do not exist in production, even in mock mode, without the explicit pilot-demo flag', () => {
    expect(runtime({ NODE_ENV: 'production', TIKTOK_MODE: 'mock' }).mockEndpointsEnabled).toBe(
      false,
    );
    expect(
      runtime({
        NODE_ENV: 'production',
        TIKTOK_MODE: 'mock',
        TIKTOK_ALLOW_MOCK_IN_PRODUCTION: true,
      }).mockEndpointsEnabled,
    ).toBe(true);
    expect(
      runtime({
        NODE_ENV: 'production',
        TIKTOK_MODE: 'live',
        TIKTOK_ALLOW_MOCK_IN_PRODUCTION: true,
      }).mockEndpointsEnabled,
    ).toBe(false);
  });
});

describe('addresses and readiness', () => {
  const live = {
    NODE_ENV: 'production',
    TIKTOK_MODE: 'live',
    TIKTOK_APP_KEY: '6abc12',
    TIKTOK_APP_SECRET: 'a-sixteen-char-secret',
    API_PUBLIC_URL: 'https://api.shop.example/',
    COURIER_CREDENTIALS_KEY: 'a2V5',
    WEB_APP_URL: 'https://app.shop.example/',
  } as const;
  it('derives the webhook, redirect and begin addresses from API_PUBLIC_URL without a double slash', () => {
    const r = runtime(live);
    expect(r.webhookUrl).toBe('https://api.shop.example/v1/webhooks/tiktok-shop');
    expect(r.redirectUri).toBe(
      'https://api.shop.example/v1/integrations/tiktok-shop/oauth/callback',
    );
    expect(r.beginUrl).toBe('https://api.shop.example/v1/integrations/tiktok-shop/oauth/begin');
    expect(r.webAppUrl).toBe('https://app.shop.example');
    expect(r.liveConfigured).toBe(true);
  });
  it('is not live-configured without every piece, and then refuses to hand out a client', () => {
    for (const missing of [
      'TIKTOK_APP_KEY',
      'TIKTOK_APP_SECRET',
      'API_PUBLIC_URL',
      'COURIER_CREDENTIALS_KEY',
    ]) {
      const r = runtime({ ...live, [missing]: undefined });
      expect(r.liveConfigured, missing).toBe(false);
      expect(() => r.tiktok(), missing).toThrow(/not set up/);
    }
    expect(() => runtime({ ...live, TIKTOK_MODE: 'mock' }).tiktok()).toThrow(/not set up/);
    expect(runtime(live).tiktok()).toBeTruthy();
  });
  it('uses the fake clock it is given', () => {
    const when = new Date('2026-01-01T00:00:00Z');
    expect(new TikTokRuntime({ ...base } as AppConfig, {}, () => when).now()).toBe(when);
  });
});

describe('TikTok failures in the API’s words', () => {
  it('maps each kind to a code, never forwarding TikTok’s own text', () => {
    const p = (kind: ConstructorParameters<typeof TikTokApiError>[0]) =>
      tiktokProblem(new TikTokApiError(kind, 'access_token=ROW_secret leaked', 400, 1));
    expect(p('token_invalid').code).toBe('tiktok_token_invalid');
    expect(p('permission').code).toBe('tiktok_permission_denied');
    expect(p('rate_limited').code).toBe('rate_limited');
    expect(p('bad_request').code).toBe('tiktok_unavailable');
    expect(p('unavailable').code).toBe('tiktok_unavailable');
    expect(tiktokProblem(new Error('boom')).code).toBe('tiktok_unavailable');
    for (const kind of [
      'token_invalid',
      'permission',
      'rate_limited',
      'bad_request',
      'unavailable',
    ] as const)
      expect(JSON.stringify(p(kind))).not.toContain('ROW_secret');
  });
});
