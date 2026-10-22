import { describe, expect, it } from 'vitest';
import { loadServerEnv } from './server-env.js';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('TENANT_DELETION_GRACE_DAYS', () => {
  it('defaults to 14 days', () => {
    expect(loadServerEnv(base).TENANT_DELETION_GRACE_DAYS).toBe(14);
  });
  it('accepts 1 to 365', () => {
    expect(
      loadServerEnv({ ...base, TENANT_DELETION_GRACE_DAYS: '1' }).TENANT_DELETION_GRACE_DAYS,
    ).toBe(1);
    expect(
      loadServerEnv({ ...base, TENANT_DELETION_GRACE_DAYS: '365' }).TENANT_DELETION_GRACE_DAYS,
    ).toBe(365);
  });
  it('refuses 0, a fraction, a negative number, more than a year and text: a deletion must always have a grace period', () => {
    for (const bad of ['0', '0.5', '-3', '366', 'soon'])
      expect(() => loadServerEnv({ ...base, TENANT_DELETION_GRACE_DAYS: bad }), bad).toThrow();
  });
});
