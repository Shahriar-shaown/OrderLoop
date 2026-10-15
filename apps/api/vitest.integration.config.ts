import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { testEnv } from './test/test-env.js';

// Integration tests need PostgreSQL and Redis (pnpm services:up). They run against the isolated
// *_test database and Redis index 1, never the development data.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ['test/**/*.e2e.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    env: { ...testEnv },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
