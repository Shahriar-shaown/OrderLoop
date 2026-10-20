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

  it('requires https and a real host outside development', () => {
    for (const API_URL of ['http://api.example.com', 'https://localhost:4000', 'https://10.0.2.2'])
      expect(() => parsePublicEnv({ API_URL, APP_ENV: 'production' }), API_URL).toThrow(/https/);
    expect(parsePublicEnv({ API_URL: 'https://api.example.com', APP_ENV: 'staging' }).APP_ENV).toBe(
      'staging',
    );
    expect(
      parsePublicEnv({ API_URL: 'http://localhost:4000', APP_ENV: 'development' }).API_URL,
    ).toBe('http://localhost:4000');
  });
});
