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
