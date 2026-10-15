import { z } from 'zod';

export const PublicEnv = z.object({
  API_URL: z.string().url(),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
});
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
