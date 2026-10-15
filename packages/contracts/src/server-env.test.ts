import { describe, expect, it } from 'vitest';
import { loadServerEnv } from './server-env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadServerEnv', () => {
  it('applies defaults', () => {
    expect(loadServerEnv(valid)).toMatchObject({ API_PORT: 4000, NODE_ENV: 'development' });
  });
  it('lists every invalid variable', () => {
    expect(() => loadServerEnv({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });
});

describe('auth env', () => {
  it('requires signing keys in production', () => {
    expect(() => loadServerEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/JWT_PRIVATE_KEY/);
  });
  it('rejects a half-configured key pair', () => {
    expect(() => loadServerEnv({ ...valid, JWT_PRIVATE_KEY: 'x' })).toThrow(/both/);
  });
  it('splits WEB_ORIGINS', () => {
    expect(
      loadServerEnv({ ...valid, WEB_ORIGINS: 'http://a.test, http://b.test' }).WEB_ORIGINS,
    ).toEqual(['http://a.test', 'http://b.test']);
  });
});
