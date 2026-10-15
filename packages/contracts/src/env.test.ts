import { describe, expect, it } from 'vitest';
import { parsePublicEnv } from './env.js';

describe('parsePublicEnv', () => {
  it('accepts a valid API url and defaults APP_ENV', () => {
    expect(parsePublicEnv({ API_URL: 'http://localhost:4000' })).toEqual({
      API_URL: 'http://localhost:4000',
      APP_ENV: 'development',
    });
  });
  it('rejects a missing or malformed API url', () => {
    expect(() => parsePublicEnv({})).toThrow(/API_URL/);
    expect(() => parsePublicEnv({ API_URL: 'not a url' })).toThrow(/API_URL/);
  });
});
