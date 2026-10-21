import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const ServerEnv = z
  .object({
    /** Required, with no default: production safeguards (signing keys, mail provider) key off it, so a deploy that forgets it must fail to start, not quietly run as development. */
    NODE_ENV: z.enum(['development', 'test', 'production']),
    API_PORT: z.coerce.number().int().positive().default(4000),
    /** Runtime role (app_user). NOBYPASSRLS; never the owner or a superuser. */
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    /** Base64 PKCS8 PEM (Ed25519). Optional in development (ephemeral key), required in production. */
    JWT_PRIVATE_KEY: z.string().min(1).optional(),
    JWT_PUBLIC_KEY: z.string().min(1).optional(),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** After a refresh token is exchanged, presenting it again this long is a retry (lost response), not theft. 0 turns the grace off. */
    REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(60).default(10),
    /** `console` prints emails to the log (development only); `smtp` sends through SMTP_* (Mailpit locally, any provider in production). */
    MAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
    MAIL_FROM: z.string().min(3).default('OrderLoop <no-reply@orderloop.invalid>'),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    /** Implicit TLS (port 465). Leave false for STARTTLS on 587 or plain local Mailpit. */
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Number of reverse-proxy hops in front of the API (0 = none). Needed for correct client IPs behind a load balancer. */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    /** Disable only in automated tests. */
    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /**
     * 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts courier credentials at rest. Without it the courier
     * connections that need secrets are unavailable (the simulated courier still works); it is never logged or returned.
     */
    COURIER_CREDENTIALS_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'Must be 32 bytes, base64 encoded')
      .optional(),
    /** A name for the key above, stored beside each secret so keys can be rotated. */
    COURIER_CREDENTIALS_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .default('k1'),
    /** Retired keys still needed to read old secrets: `id:base64,id:base64`. */
    COURIER_CREDENTIALS_OLD_KEYS: z.string().default(''),
    /** The simulated courier. On by default everywhere except production, where it must be switched on on purpose. */
    COURIER_MOCK_ENABLED: z.enum(['true', 'false']).optional(),
    /** The address couriers can reach this API on, used to show the webhook URL to paste into a courier's panel. */
    API_PUBLIC_URL: z.string().url().optional(),
    /**
     * How push notifications are sent. `dev` (default) only logs a redacted line and records the delivery as sent, and can write
     * what it "sent" to PUSH_DEV_OUTBOX; nothing reaches a phone. `expo` posts to Expo's push service (free; EXPO_ACCESS_TOKEN
     * is only needed if the Expo project enforces access tokens).
     */
    PUSH_PROVIDER: z.enum(['dev', 'expo']).default('dev'),
    /** Dev provider only: append every push it would have sent, as one JSON line each, to this file. */
    PUSH_DEV_OUTBOX: z.string().min(1).optional(),
    EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
    /** `none`: the channel is unavailable (rules cannot enable it: 422 channel_not_configured). `console`: logs a redacted line only. No vendor is integrated. */
    SMS_PROVIDER: z.enum(['none', 'console']).default('none'),
    WHATSAPP_PROVIDER: z.enum(['none', 'console']).default('none'),
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
    if (env.MAIL_PROVIDER === 'smtp' && !env.SMTP_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST is required when MAIL_PROVIDER=smtp',
      });
    }
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_PASSWORD'],
        message: 'Set both SMTP_USER and SMTP_PASSWORD, or neither',
      });
    }
    if (env.NODE_ENV === 'production' && env.MAIL_PROVIDER === 'console') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_PROVIDER'],
        message: 'MAIL_PROVIDER=console prints tokens to the log; configure smtp in production',
      });
    }
    for (const entry of env.COURIER_CREDENTIALS_OLD_KEYS.split(',').filter(Boolean)) {
      const [id, key] = entry.split(':');
      if (!id || !key || Buffer.from(key, 'base64').length !== 32)
        ctx.addIssue({
          code: 'custom',
          path: ['COURIER_CREDENTIALS_OLD_KEYS'],
          message: 'Each entry must be id:base64 with a 32-byte key',
        });
    }
    if (
      env.NODE_ENV === 'production' &&
      env.API_PUBLIC_URL &&
      !env.API_PUBLIC_URL.startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['API_PUBLIC_URL'],
        message: 'API_PUBLIC_URL must be https in production (couriers post webhook secrets to it)',
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
