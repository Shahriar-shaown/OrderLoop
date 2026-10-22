// Guards for the deployment artifacts (deploy/, ops/): the facts that must stay in step across files, so that a change in one place
// that forgets another fails CI instead of failing a deployment. Run by `node --test scripts/*.test.mjs` (part of `pnpm test`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const major = (v) =>
  Number(
    String(v)
      .replace(/^[^\d]*/, '')
      .split('.')[0],
  );

const dockerfile = read('deploy/Dockerfile');
const compose = read('deploy/docker-compose.yml');
const deployEnv = read('deploy/.env.example');
const rootEnv = read('.env.example');
const serverEnv = read('packages/contracts/src/server-env.ts');
const alerts = read('ops/monitoring/alerts.yml');
const incident = read('docs/operations/incident-response.md');

/** Variable names an env example documents, set or commented out (`KEY=` or `# KEY=`). */
const documented = (text) =>
  new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));

test('the Node image has the major of .nvmrc and an exact version', () => {
  const image = /^ARG NODE_IMAGE=(node:(\d+\.\d+\.\d+)-[a-z0-9.-]+)$/m.exec(dockerfile);
  assert.ok(
    image,
    'deploy/Dockerfile must pin an exact node:<major>.<minor>.<patch>-<variant> image',
  );
  assert.equal(
    major(image[2]),
    major(read('.nvmrc').trim()),
    'Dockerfile Node major differs from .nvmrc',
  );
});

test('the Dockerfile uses the pnpm version of package.json', () => {
  const pinned = /^ARG PNPM_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
  const wanted = JSON.parse(read('package.json')).packageManager.replace(/^pnpm@/, '');
  assert.equal(pinned, wanted);
});

test('pg_dump (ops image) is the same PostgreSQL major as the server', () => {
  const ops = /^ARG POSTGRES_IMAGE=postgres:(\d+)\.\d+-/m.exec(dockerfile)?.[1];
  const server = /image: postgres:(\d+)\.\d+-/.exec(compose)?.[1];
  assert.ok(ops && server, 'both must pin an exact postgres:<major>.<minor> tag');
  assert.equal(ops, server);
});

test('every image in the compose file is pinned to an exact version (no latest, no floating major)', () => {
  const images = [...compose.matchAll(/^\s+image: (\S+)$/gm)]
    .map((m) => m[1])
    .filter((i) => !i.includes('${'));
  assert.ok(images.length >= 8);
  for (const image of images)
    assert.match(image, /:[v]?\d+\.\d+(\.\d+)?(-[a-z0-9.]+)?$/, `${image} is not pinned exactly`);
});

test('every server environment variable is documented in deploy/.env.example and in .env.example', () => {
  const start = serverEnv.indexOf('const ServerEnvShape = z.object({');
  const shape = serverEnv.slice(start, serverEnv.indexOf('\n});', start));
  const keys = [...shape.matchAll(/^ {2}([A-Z][A-Z0-9_]+): /gm)].map((m) => m[1]);
  assert.ok(keys.length > 40, 'could not read the variables from server-env.ts');
  for (const [name, text] of [
    ['deploy/.env.example', deployEnv],
    ['.env.example', rootEnv],
  ]) {
    const have = documented(text);
    const missing = keys.filter((k) => !have.has(k));
    assert.deepEqual(missing, [], `${name} does not document: ${missing.join(', ')}`);
  }
});

test('every ${VARIABLE} the compose file reads is documented in deploy/.env.example', () => {
  const have = documented(deployEnv);
  const used = new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !have.has(v));
  assert.deepEqual(missing, [], `deploy/.env.example does not document: ${missing.join(', ')}`);
});

test('deploy/.env.example holds placeholders only: no real-looking secret, REGISTRATION_MODE and META_MODE are explicit', () => {
  for (const [name, value] of deployEnv
    .matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)
    .map((m) => [m[1], m[2]])) {
    if (
      /PASSWORD|TOKEN|SECRET|KEY/.test(name) &&
      !/^(SMTP_PASSWORD|)$/.test(name) &&
      !/^BACKUP_KEEP|KEY_ID/.test(name)
    )
      assert.match(value, /^(CHANGE_ME|)$/, `${name} must be a placeholder, not a value`);
    assert.ok(value.length < 80, `${name} has an implausibly long value for a placeholder`);
  }
  assert.match(deployEnv, /^REGISTRATION_MODE=(allowlist|open)$/m);
  assert.match(deployEnv, /^META_MODE=(mock|live)$/m);
});

test('the generated env file is git-ignored and secrets never reach the repository', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^deploy\/\.env$/m);
  assert.match(ignore, /^deploy\/backup-age-identity\.txt$/m);
  const dockerignore = read('.dockerignore');
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^deploy\/\.env$/m);
});

test('the application containers are never given the superuser or owner credentials', () => {
  for (const service of ['api', 'worker', 'web']) {
    const start = compose.indexOf(`\n  ${service}:\n`);
    assert.ok(start > 0, `service ${service} not found`);
    const next = compose.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    const body = compose.slice(start, next > 0 ? start + 1 + next : undefined);
    assert.doesNotMatch(
      body,
      /POSTGRES_PASSWORD|DATABASE_ADMIN_URL|DATABASE_MIGRATION_URL|DATABASE_MIGRATOR_PASSWORD|DATABASE_BACKUP_PASSWORD/,
      `${service} must not receive admin, owner or backup credentials`,
    );
  }
});

test('every alert has a runbook that points at a real section of incident-response.md', () => {
  const slug = (h) =>
    h
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .trim()
      .replace(/ /g, '-');
  const anchors = new Set([...incident.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
  const rules = [...alerts.matchAll(/- alert: (\w+)/g)].map((m) => m[1]);
  assert.ok(rules.length >= 12);
  for (const rule of rules) {
    const block = alerts.slice(alerts.indexOf(`- alert: ${rule}`)).split(/\n {6}- alert: /)[0];
    const link = /runbook: docs\/operations\/incident-response\.md#(\S+)/.exec(block)?.[1];
    assert.ok(link, `${rule} has no runbook link`);
    assert.ok(anchors.has(link), `${rule}: incident-response.md has no section "#${link}"`);
  }
});
