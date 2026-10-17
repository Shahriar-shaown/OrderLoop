import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSelfImports, findViolations } from './check-boundaries.mjs';

test('web importing db is a violation', () => {
  assert.deepEqual(findViolations('apps/web', `import { prisma } from '@orderloop/db';`), [
    '@orderloop/db',
  ]);
});
test('dynamic import and require are caught', () => {
  assert.deepEqual(
    findViolations(
      'apps/mobile',
      `await import("@orderloop/db"); require('@orderloop/courier-sdk')`,
    ),
    ['@orderloop/db', '@orderloop/courier-sdk'],
  );
});
test('web importing contracts is allowed', () => {
  assert.deepEqual(
    findViolations('apps/web', `import { ReadyResponse } from '@orderloop/contracts';`),
    [],
  );
});
test('api and worker cannot import each other', () => {
  assert.deepEqual(findViolations('apps/api', `import x from '@orderloop/worker'`), [
    '@orderloop/worker',
  ]);
  assert.deepEqual(findViolations('apps/worker', `import x from '@orderloop/api'`), [
    '@orderloop/api',
  ]);
});
test('api-client may only depend on contracts', () => {
  assert.deepEqual(
    findViolations(
      'packages/api-client',
      `import a from '@orderloop/contracts'; import b from '@orderloop/db'`,
    ),
    ['@orderloop/db'],
  );
});
test('domain cannot import the database or api client', () => {
  assert.deepEqual(findViolations('packages/domain', `import a from '@orderloop/api-client'`), [
    '@orderloop/api-client',
  ]);
});
test('browser-side projects cannot import the Node-only contracts subpath', () => {
  const src = `import { loadDotEnv } from '@orderloop/contracts/server';`;
  assert.deepEqual(findViolations('apps/web', src), ['@orderloop/contracts/server']);
  assert.deepEqual(findViolations('apps/mobile', src), ['@orderloop/contracts/server']);
  assert.deepEqual(findViolations('apps/api', src), []);
});

test('catalog is server-side only', () => {
  const src = `import { receiveStock } from '@orderloop/catalog';`;
  assert.deepEqual(findViolations('apps/web', src), ['@orderloop/catalog']);
  assert.deepEqual(findViolations('apps/mobile', src), ['@orderloop/catalog']);
  assert.deepEqual(findViolations('packages/domain', src), ['@orderloop/catalog']);
  assert.deepEqual(findViolations('apps/api', src), []);
  assert.deepEqual(findViolations('apps/worker', src), []);
});
test('catalog cannot reach into the apps', () => {
  assert.deepEqual(
    findViolations(
      'packages/catalog',
      `import a from '@orderloop/api'; import b from '@orderloop/db'; import c from '@orderloop/domain'`,
    ),
    ['@orderloop/api'],
  );
});

test('a platform file importing its own base module is caught', () => {
  assert.deepEqual(findSelfImports('theme.web.tsx', `import { x } from './theme';`), ['./theme']);
  assert.deepEqual(findSelfImports('Form.native.tsx', `const f = require('./Form')`), ['./Form']);
  assert.deepEqual(findSelfImports('Form.web.tsx', `import type { P } from "./Form";`), ['./Form']);
});
test('platform files may import other modules, including ones that merely share a prefix', () => {
  assert.deepEqual(
    findSelfImports(
      'theme.web.tsx',
      `import { c } from './themeContext'; import { p } from './tokens';`,
    ),
    [],
  );
  assert.deepEqual(findSelfImports('Form.web.tsx', `import { c } from './formContext';`), []);
});
test('ordinary files are never flagged', () => {
  assert.deepEqual(findSelfImports('theme.tsx', `import { c } from './theme';`), []);
});
