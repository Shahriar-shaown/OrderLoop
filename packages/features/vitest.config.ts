import { defineConfig } from 'vitest/config';

// Components are written against React Native; tests render them in jsdom through react-native-web, as the browser does.
export default defineConfig({
  resolve: {
    alias: { 'react-native': 'react-native-web' },
    extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.mjs', '.js', '.json'],
  },
  test: {
    environment: 'jsdom',
    // Screens render a lot of components; a busy CI machine needs more than the 5 s default.
    testTimeout: 20_000,
    globals: false,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
