import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const ServerEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
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
