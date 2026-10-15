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

function withDbSuffix(url: string): string {
  const u = new URL(url);
  u.pathname = `${u.pathname}_test`;
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
  WEB_ORIGINS: 'http://localhost:3000',
} as const;
