import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC emits decorator metadata, which Nest DI needs and esbuild does not.
export default defineConfig({
  plugins: [swc.vite()],
  test: { globals: false, include: ['src/**/*.test.ts'] },
});
