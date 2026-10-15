import { parsePublicEnv } from '@orderloop/contracts';

// Literal process.env reads are required so Next can inline NEXT_PUBLIC_* values.
export const env = parsePublicEnv({
  API_URL: process.env.NEXT_PUBLIC_API_URL,
  APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
});
