import { defineConfig } from 'vitest/config';

// Components are written against React Native; tests render them in jsdom through react-native-web, as the browser does.
export default defineConfig({
  resolve: {
    alias: { 'react-native': 'react-native-web' },
    extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.mjs', '.js', '.json'],
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
