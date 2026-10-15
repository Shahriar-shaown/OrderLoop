import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN = resolve(import.meta.dirname, '../dist/main.js');

/** Boot the real built server in an empty directory (so no .env is picked up) and see what it says. */
function boot(env: Record<string, string>) {
  return spawnSync('node', [MAIN], {
    cwd: mkdtempSync(join(tmpdir(), 'orderloop-boot-')),
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const VALID = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db',
  REDIS_URL: 'redis://127.0.0.1:1',
  API_PORT: '0',
};

describe('startup environment validation (the built server, run for real)', () => {
  it('exits non-zero and lists every missing variable', () => {
    const r = boot({});
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Invalid environment');
    expect(r.stderr).toContain('DATABASE_URL');
    expect(r.stderr).toContain('REDIS_URL');
  });

  it('rejects a malformed value, naming the variable', () => {
    const r = boot({ ...VALID, DATABASE_URL: 'not a url', API_PORT: 'banana' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/DATABASE_URL/);
    expect(r.stderr).toMatch(/API_PORT/);
  });

  it('refuses production without signing keys, and with the console mail provider', () => {
    const r = boot({ ...VALID, NODE_ENV: 'production' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('JWT_PRIVATE_KEY');
    expect(r.stderr).toContain('MAIL_PROVIDER');
  });

  it('refuses to start when NODE_ENV is not set, rather than defaulting to development safeguards', () => {
    const withoutNodeEnv = Object.fromEntries(
      Object.entries(VALID).filter(([key]) => key !== 'NODE_ENV'),
    );
    const r = boot(withoutNodeEnv);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('NODE_ENV');
  });

  it('requires SMTP_HOST when the smtp provider is selected', () => {
    const r = boot({ ...VALID, MAIL_PROVIDER: 'smtp' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SMTP_HOST');
  });

  it('does not echo secret values in the error', () => {
    const r = boot({
      ...VALID,
      DATABASE_URL: 'not a url but hunter2-secret',
      SMTP_PASSWORD: 'smtp-secret-value',
    });
    expect(r.stderr + r.stdout).not.toContain('hunter2-secret');
    expect(r.stderr + r.stdout).not.toContain('smtp-secret-value');
  });
});
