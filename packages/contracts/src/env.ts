import { z } from 'zod';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|10\.0\.2\.2|.*\.localhost)$/;

export const PublicEnv = z
  .object({
    API_URL: z.string().url(),
    APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  })
  // A staging or production build must talk to a real server over TLS: never a cleartext or local address.
  .refine(
    ({ API_URL, APP_ENV }) => {
      if (APP_ENV === 'development') return true;
      const url = new URL(API_URL);
      return url.protocol === 'https:' && !LOCAL_HOST.test(url.hostname);
    },
    {
      path: ['API_URL'],
      message: 'must be an https address of a real server when APP_ENV is staging or production',
    },
  );
export type PublicEnv = z.infer<typeof PublicEnv>;

/**
 * Validate client-side env. Bundlers only inline *literal* `process.env.X` reads, so callers pass an
 * explicit object rather than `process.env`.
 */
export function parsePublicEnv(source: {
  API_URL?: string | undefined;
  APP_ENV?: string | undefined;
}): PublicEnv {
  const result = PublicEnv.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid public environment (check .env against .env.example):\n${issues}`);
  }
  return result.data;
}
