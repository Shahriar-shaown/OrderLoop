// An API on :4100 against the isolated test database, for trying the app on a simulator or device without touching the
// development data (the same stack the web e2e tests use). Refuses to run for a non-local database.. Needs `pnpm services:up` and a built API (`pnpm --filter @orderloop/api build`).
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  process.loadEnvFile(resolve(root, '.env'));
} catch {
  // CI-style: rely on the ambient environment.
}
const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; copy .env.example to .env`);
  return v;
};
const withDb = (url, db) => {
  const u = new URL(url);
  u.pathname = db;
  return u.toString();
};
for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  const host = new URL(need(name)).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host))
    throw new Error(`${name} is not local (${host}): this launcher is for development only`);
}
const PORT = process.env.MOBILE_TEST_API_PORT ?? '4100';

const child = spawn('node', ['dist/main.js'], {
  cwd: resolve(root, 'apps/api'),
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    API_PORT: PORT,
    DATABASE_URL: withDb(need('DATABASE_URL'), '/orderloop_test'),
    DATABASE_MIGRATION_URL: withDb(need('DATABASE_MIGRATION_URL'), '/orderloop_test'),
    REDIS_URL: withDb(need('REDIS_URL'), '/2'),
    RATE_LIMIT_ENABLED: 'false',
    MAIL_PROVIDER: 'smtp',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    COURIER_MOCK_ENABLED: 'true',
  },
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
