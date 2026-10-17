import { defineConfig } from '@playwright/test';
import { PORTS } from './e2e/env';

// The system's Chrome is used (no browser download). Set E2E_SKIP_BUILD=1 to reuse the last build.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  // One database, one worker: scenarios create their own uniquely named users but share the stack.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORTS.web}`,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
