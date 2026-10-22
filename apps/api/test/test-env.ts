// Shared by vitest.integration.config.ts and global-setup.ts: derive isolated test resources from the root .env.
import { resolve } from 'node:path';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  // CI and containers inject variables directly.
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; copy .env.example to .env and run pnpm db:setup`);
  return v;
}

/** Point a database URL at the isolated test database. Idempotent: this module is evaluated again inside test workers, where the variables already hold test values. */
function withDbSuffix(url: string): string {
  const u = new URL(url);
  if (!u.pathname.endsWith('_test')) u.pathname = `${u.pathname}_test`;
  return u.toString();
}

function redisDb1(url: string): string {
  const u = new URL(url);
  u.pathname = '/1';
  return u.toString();
}

export const testEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: withDbSuffix(need('DATABASE_URL')),
  DATABASE_MIGRATION_URL: withDbSuffix(need('DATABASE_MIGRATION_URL')),
  DATABASE_ADMIN_URL: need('DATABASE_ADMIN_URL'),
  REDIS_URL: redisDb1(need('REDIS_URL')),
  RATE_LIMIT_ENABLED: 'false',
  LOG_LEVEL: 'silent',
  MAIL_PROVIDER: 'console',
  WEB_ORIGINS: 'http://localhost:3000',
  // A fixed key for tests only (not a secret: it protects nothing outside the throwaway test database).
  COURIER_CREDENTIALS_KEY: Buffer.from('orderloop-test-courier-key-00000').toString('base64'),
  COURIER_MOCK_ENABLED: 'true',
  // Tests replay used tokens to check theft detection; the grace-window tests turn the window on.
  REFRESH_REUSE_GRACE_SECONDS: '0',
  // The worker the import tests spawn must not collide with a development worker on the default health port (4010).
  WORKER_HEALTH_PORT: '4311',
} as const;
