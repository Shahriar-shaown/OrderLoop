import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import { testEnv } from './test-env.js';

function run(args: string[], env: Record<string, string>) {
  const result = spawnSync('pnpm', args, {
    cwd: resolve(import.meta.dirname, '../../..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`pnpm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
}

/** Provision roles and the isolated test database, apply migrations, and empty the test Redis index. */
export default async function setup(): Promise<void> {
  run(['--filter', '@orderloop/db', 'run', 'setup-roles'], {
    DATABASE_ADMIN_URL: testEnv.DATABASE_ADMIN_URL,
  });
  run(['--filter', '@orderloop/db', 'run', 'migrate:deploy'], {
    DATABASE_MIGRATION_URL: testEnv.DATABASE_MIGRATION_URL,
  });

  const redis = new Redis(testEnv.REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}
