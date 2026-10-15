import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const ServerEnv = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    /** Runtime role (app_user). NOBYPASSRLS; never the owner or a superuser. */
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    /** Base64 PKCS8 PEM (Ed25519). Optional in development (ephemeral key), required in production. */
    JWT_PRIVATE_KEY: z.string().min(1).optional(),
    JWT_PUBLIC_KEY: z.string().min(1).optional(),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** Number of reverse-proxy hops in front of the API (0 = none). Needed for correct client IPs behind a load balancer. */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    /** Disable only in automated tests. */
    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** Comma-separated browser origins allowed to call the API with credentials. */
    WEB_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((v) =>
        v
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !(env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_PRIVATE_KEY'],
        message: 'JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required in production',
      });
    }
    if (Boolean(env.JWT_PRIVATE_KEY) !== Boolean(env.JWT_PUBLIC_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_PUBLIC_KEY'],
        message: 'Set both JWT_PRIVATE_KEY and JWT_PUBLIC_KEY, or neither',
      });
    }
  });
export type ServerEnv = z.infer<typeof ServerEnv>;

/** Parse and validate process env; throws a readable error listing every bad variable. */
export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const result = ServerEnv.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}

/** Load the nearest `.env` walking up from cwd (dev convenience; no-op if none found). Vars already in the process win. */
export function loadDotEnv(startDir: string = process.cwd()): void {
  let dir = startDir;
  for (;;) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
