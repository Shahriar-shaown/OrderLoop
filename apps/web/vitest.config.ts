import { defineConfig } from 'vitest/config';

// Browser scenarios under e2e/ belong to Playwright (pnpm test:e2e), not to the unit-test runner.
export default defineConfig({
  test: { exclude: ['e2e/**', 'build/**', '.next/**', 'node_modules/**'] },
});
