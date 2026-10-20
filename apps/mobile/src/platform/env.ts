import { parsePublicEnv } from '@orderloop/contracts';

// Literal process.env reads are required so Expo can inline EXPO_PUBLIC_* values.
export const env = parsePublicEnv({
  API_URL: process.env.EXPO_PUBLIC_API_URL,
  APP_ENV: process.env.EXPO_PUBLIC_APP_ENV,
});
