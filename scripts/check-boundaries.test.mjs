import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations } from './check-boundaries.mjs';

test('web importing db is a violation', () => {
  assert.deepEqual(findViolations('apps/web', `import { prisma } from '@orderloop/db';`), ['@orderloop/db']);
});
test('dynamic import and require are caught', () => {
  assert.deepEqual(findViolations('apps/mobile', `await import("@orderloop/db"); require('@orderloop/courier-sdk')`), ['@orderloop/db', '@orderloop/courier-sdk']);
});
test('web importing contracts is allowed', () => {
  assert.deepEqual(findViolations('apps/web', `import { ReadyResponse } from '@orderloop/contracts';`), []);
});
test('api and worker cannot import each other', () => {
  assert.deepEqual(findViolations('apps/api', `import x from '@orderloop/worker'`), ['@orderloop/worker']);
  assert.deepEqual(findViolations('apps/worker', `import x from '@orderloop/api'`), ['@orderloop/api']);
});
