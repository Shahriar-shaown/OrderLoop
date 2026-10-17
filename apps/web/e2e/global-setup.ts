import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import { MAILPIT, PORTS, repoRoot, stackEnv } from './env';

const children: ChildProcess[] = [];

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('pnpm', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
}

function start(
  name: string,
  cwd: string,
  command: string,
  args: string[],
  env: Record<string, string>,
) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail: string[] = [];
  const keep = (chunk: Buffer) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${chunk.toString()}`);
    tail.push(...chunk.toString().split('\n'));
    tail.splice(0, Math.max(0, tail.length - 40));
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.on('exit', (code) => {
    if (code && code !== 143)
      console.error(`[e2e] ${name} exited with ${code}:\n${tail.join('\n')}`);
  });
  children.push(child);
}

async function waitFor(url: string, label: string, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

/** Provision the isolated database, build and start the whole stack (API, worker, web), and clear the test queue. */
export default async function setup() {
  // Mailpit must be running (pnpm services:up): without it no email, hence no verification or reset link, can arrive.
  try {
    await fetch(`${MAILPIT}/api/v1/info`);
  } catch {
    throw new Error(`Mailpit is not reachable at ${MAILPIT}. Run "pnpm services:up" first.`);
  }

  run(repoRoot, ['--filter', '@orderloop/db', 'run', 'setup-roles'], {
    DATABASE_ADMIN_URL: stackEnv.DATABASE_ADMIN_URL,
  });
  run(repoRoot, ['--filter', '@orderloop/db', 'run', 'migrate:deploy'], {
    DATABASE_MIGRATION_URL: stackEnv.DATABASE_MIGRATION_URL,
  });

  const redis = new Redis(stackEnv.REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }

  const webDir = resolve(repoRoot, 'apps/web');
  // A production build: what users get, and free of development-only console noise. Its own folder keeps `next dev` safe.
  if (!process.env.E2E_SKIP_BUILD)
    run(webDir, ['exec', 'next', 'build'], { ...stackEnv, NEXT_DIST_DIR: 'build/e2e' });

  start('api', resolve(repoRoot, 'apps/api'), 'node', ['dist/main.js'], stackEnv);
  start('worker', resolve(repoRoot, 'apps/worker'), 'node', ['dist/main.js'], stackEnv);
  start('web', webDir, 'pnpm', ['exec', 'next', 'start', '-p', String(PORTS.web)], {
    ...stackEnv,
    NEXT_DIST_DIR: 'build/e2e',
  });

  await waitFor(`http://localhost:${PORTS.api}/health/live`, 'API');
  await waitFor(`http://localhost:${PORTS.web}/login`, 'web app');

  return async () => {
    for (const child of children) child.kill('SIGTERM');
  };
}
