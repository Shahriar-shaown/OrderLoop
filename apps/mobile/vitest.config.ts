import { defineConfig } from 'vitest/config';

// Logic around the native app (routes, device storage wiring) runs in plain Node. The screens themselves are shared with
// the web app and are tested in packages/features (rendered through react-native-web).
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
