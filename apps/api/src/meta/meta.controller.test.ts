import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/config.module.js';
import { cookieOptions, readCookie } from './meta.controller.js';

describe('readCookie', () => {
  it('finds one cookie among several, and nothing when absent or malformed', () => {
    expect(readCookie('a=1; ol_meta_oauth=abc_-9; b=2', 'ol_meta_oauth')).toBe('abc_-9');
    expect(readCookie('xol_meta_oauth=abc', 'ol_meta_oauth')).toBeUndefined();
    expect(readCookie(undefined, 'ol_meta_oauth')).toBeUndefined();
    expect(readCookie('ol_meta_oauth', 'ol_meta_oauth')).toBeUndefined();
  });
});

describe('cookieOptions', () => {
  it('is HttpOnly, SameSite=Lax and path-scoped, and Secure only in production', () => {
    const prod = cookieOptions({ NODE_ENV: 'production' } as AppConfig);
    expect(prod).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/v1/integrations/meta/oauth',
    });
    expect(cookieOptions({ NODE_ENV: 'development' } as AppConfig).secure).toBe(false);
  });
});
