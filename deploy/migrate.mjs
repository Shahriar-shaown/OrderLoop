// One-shot deployment job (the `migrate` service of deploy/docker-compose.yml). In order:
//   1. roles and grants         : the `pnpm db:setup` equivalent (packages/db/scripts/setup-roles.mjs), as the superuser
//   2. backup and monitor roles : deploy/setup-ops-roles.mjs (only if their passwords are set)
//   3. `prisma migrate deploy`  : as the OWNER role app_migrator (never as the superuser, never as app_user)
//   4. `prisma migrate status`  : must say the schema is up to date, else the job fails
// Every step is idempotent, so re-running it on each deploy is the intended use. Exit code 0 only if all four passed.
// Environment: DATABASE_ADMIN_URL (superuser), DATABASE_MIGRATION_URL (app_migrator), DATABASE_URL (app_user).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const log = (step, status, extra = {}) =>
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event: 'migrate', step, status, ...extra }),
  );

for (const name of ['DATABASE_ADMIN_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_URL']) {
  if (!process.env[name]) {
    log('env', 'failed', { missing: name });
    process.exit(2);
  }
}

function run(step, command, args, env = {}) {
  log(step, 'started');
  const r = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    log(step, 'failed', { exitCode: r.status });
    process.exit(r.status ?? 1);
  }
  log(step, 'ok');
}

run('roles', 'node', ['scripts/setup-roles.mjs'], { SETUP_ROLES_SKIP_TEST_DB: '1' });
run('ops-roles', 'node', ['deploy/setup-ops-roles.mjs']);
const prisma = ['node_modules/prisma/build/index.js'];
run('migrate-deploy', 'node', [...prisma, 'migrate', 'deploy']);
run('migrate-status', 'node', [...prisma, 'migrate', 'status']);
log('done', 'ok');
