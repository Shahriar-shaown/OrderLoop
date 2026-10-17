import { resolve } from 'node:path';

/** Ports for the end-to-end stack, chosen to leave the usual dev ports (3000, 4000) alone. */
export const PORTS = { web: 3100, api: 4100 } as const;
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

const root = resolve(__dirname, '../../..');
try {
  process.loadEnvFile(resolve(root, '.env'));
} catch {
  // CI injects variables directly.
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; copy .env.example to .env`);
  return v;
}

const withTestDb = (url: string) => {
  const u = new URL(url);
  if (!u.pathname.endsWith('_test')) u.pathname = `${u.pathname}_test`;
  return u.toString();
};
const redisDb = (url: string, db: number) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

/** An isolated database and Redis index (the API integration tests use `_test` and Redis 1; this uses Redis 2). */
export const stackEnv = {
  NODE_ENV: 'test',
  API_PORT: String(PORTS.api),
  DATABASE_URL: withTestDb(need('DATABASE_URL')),
  DATABASE_MIGRATION_URL: withTestDb(need('DATABASE_MIGRATION_URL')),
  DATABASE_ADMIN_URL: need('DATABASE_ADMIN_URL'),
  REDIS_URL: redisDb(need('REDIS_URL'), 2),
  WEB_ORIGINS: `http://localhost:${PORTS.web}`,
  RATE_LIMIT_ENABLED: 'false',
  LOG_LEVEL: process.env.E2E_VERBOSE ? 'debug' : 'warn',
  // Real emails, delivered to Mailpit, so the tests follow the same links a person would.
  MAIL_PROVIDER: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  NEXT_PUBLIC_API_URL: `http://localhost:${PORTS.api}`,
  NEXT_PUBLIC_APP_ENV: 'development',
} as const;

export const repoRoot = root;
