import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** One entry of REGISTRATION_ALLOWED_EMAILS: an exact email or `@domain.com`, lower-cased. */
const ALLOWLIST_ENTRY =
  /^(@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

/** Whether `email` may create a new business under `REGISTRATION_MODE`. Case-insensitive; `@domain.com` allows the whole domain (not subdomains). */
export function registrationAllowed(
  env: Pick<ServerEnv, 'REGISTRATION_MODE' | 'REGISTRATION_ALLOWED_EMAILS'>,
  email: string,
): boolean {
  if (env.REGISTRATION_MODE === 'open') return true;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return false;
  const domain = e.slice(at);
  return env.REGISTRATION_ALLOWED_EMAILS.some((entry) => entry === e || entry === domain);
}

const ServerEnvShape = z.object({
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
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Number of reverse-proxy hops in front of the API (0 = none). Needed for correct client IPs behind a load balancer: with 0
   * behind a proxy every client shares the proxy's IP (one rate-limit bucket for everyone, the proxy's IP in audit logs).
   * Production requires >= 1 unless TRUST_PROXY_NONE_OK=true.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  /** Production only: confirms on purpose that the API is reached directly by clients (no proxy or load balancer), so TRUST_PROXY=0 is right. */
  TRUST_PROXY_NONE_OK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Serve GET /openapi.json to anyone (default). Set false to answer 404 there; the document describes every route but holds no secrets. */
  OPENAPI_PUBLIC: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
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
  /**
   * Meta (Facebook Page + Instagram messages). `mock` (default): a clearly labelled simulated provider, no Meta account involved.
   * `live`: the real thing, written against Meta's documentation and NOT yet tested with authorised credentials (docs/meta.md).
   */
  META_MODE: z.enum(['mock', 'live']).optional(),
  /**
   * Pilot-demo only. In production the mock Meta endpoints (create a mock connection, inject a fake message) answer 404 even
   * when META_MODE=mock, unless this is true. Never set it on a server that holds real customers' data.
   */
  META_ALLOW_MOCK_IN_PRODUCTION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  META_APP_ID: z
    .string()
    .regex(/^\d{5,30}$/, 'The Meta app id is numeric')
    .optional(),
  /** The App Secret: signs webhooks (X-Hub-Signature-256), the OAuth state and the deauthorize / data-deletion requests. Never logged or returned. */
  META_APP_SECRET: z.string().min(16).optional(),
  /** The string you also type into the Meta dashboard's webhook "Verify token" box. */
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(16).optional(),
  /** Graph API version, pinned on purpose (e.g. v23.0). Check Meta's changelog for the versions that are currently supported. */
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d{1,2}\.\d{1,2}$/, 'Use a Graph API version like v23.0')
    .optional(),
  /** Facebook Login for Business: the id of the login configuration that holds the permissions. Without it the classic `scope` dialog is used. */
  META_LOGIN_CONFIG_ID: z
    .string()
    .regex(/^\d{5,30}$/)
    .optional(),
  /** Days to keep webhook events, and drafts nobody confirmed (or that were dismissed), before the worker deletes them. */
  META_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Where the web app lives, for the redirect back from Meta's sign-in. Defaults to the first of WEB_ORIGINS. */
  WEB_APP_URL: z.string().url().optional(),
  /**
   * `open`: anyone can sign up. `allowlist`: only the emails in REGISTRATION_ALLOWED_EMAILS can create a new business
   * (pilot). Accepting an invitation, signing in, verifying and password reset are not affected. Outside production the default
   * is `open`; production must choose on purpose (a deploy that forgets it would quietly let anyone create a business).
   */
  REGISTRATION_MODE: z.enum(['open', 'allowlist']).optional(),
  /** Comma-separated exact emails and/or `@domain.com` entries, case-insensitive. Required (non-empty) when REGISTRATION_MODE=allowlist. */
  REGISTRATION_ALLOWED_EMAILS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  /**
   * Bearer token that protects GET /metrics on the API and on the worker's health server (Prometheus `authorization`
   * credentials). `/metrics` answers 404 on both while this is unset. 16+ characters; never logged.
   */
  METRICS_TOKEN: z.string().min(16).optional(),
  /** Port of the worker's HTTP health and metrics server (/health/live, /health/ready, /metrics). Bound to all interfaces: keep it off the public network. */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4010),
  /** Days between an owner asking for a business to be deleted and the worker deleting it for good (the owner can cancel until then). At least 1. */
  TENANT_DELETION_GRACE_DAYS: z.coerce.number().int().min(1).max(365).default(14),
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
});

type RawEnv = z.infer<typeof ServerEnvShape>;

/**
 * Cross-field and production rules. `service` says who is starting: the worker never signs tokens, never serves a browser and sits
 * behind no proxy, so the settings that only the API uses are not demanded of it (giving the worker the token-signing key would
 * only widen who holds it).
 */
function checkServerEnv(env: RawEnv, ctx: z.RefinementCtx, service: 'api' | 'worker'): void {
  if (
    service === 'api' &&
    env.NODE_ENV === 'production' &&
    !(env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_PRIVATE_KEY'],
      message: 'JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required in production',
    });
  }
  if (service === 'api' && env.NODE_ENV === 'production' && env.REGISTRATION_MODE === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['REGISTRATION_MODE'],
      message:
        'REGISTRATION_MODE must be set explicitly in production (allowlist for a pilot, open to let anyone sign up)',
    });
  }
  if (env.REGISTRATION_MODE === 'allowlist' && env.REGISTRATION_ALLOWED_EMAILS.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['REGISTRATION_ALLOWED_EMAILS'],
      message:
        'REGISTRATION_ALLOWED_EMAILS must list at least one email or @domain when REGISTRATION_MODE=allowlist',
    });
  }
  env.REGISTRATION_ALLOWED_EMAILS.forEach((entry) => {
    if (!ALLOWLIST_ENTRY.test(entry))
      ctx.addIssue({
        code: 'custom',
        path: ['REGISTRATION_ALLOWED_EMAILS'],
        message: `Each entry must be an email or @domain.com (got "${entry}")`,
      });
  });
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
  if (env.NODE_ENV === 'production' && env.META_MODE === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['META_MODE'],
      message: 'META_MODE must be set explicitly in production (live, or mock for a pilot demo)',
    });
  }
  if (
    service === 'api' &&
    env.NODE_ENV === 'production' &&
    env.TRUST_PROXY < 1 &&
    !env.TRUST_PROXY_NONE_OK
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['TRUST_PROXY'],
      message:
        'TRUST_PROXY must be >= 1 in production behind a load balancer (otherwise every client shares one IP for rate limits and audit). If clients really connect directly, set TRUST_PROXY_NONE_OK=true',
    });
  }
  if (service === 'api' && env.NODE_ENV === 'production') {
    env.WEB_ORIGINS.forEach((origin) => {
      if (!origin.startsWith('https://'))
        ctx.addIssue({
          code: 'custom',
          path: ['WEB_ORIGINS'],
          message: `WEB_ORIGINS must be https in production (got ${origin})`,
        });
    });
    if (env.WEB_APP_URL && !env.WEB_APP_URL.startsWith('https://'))
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_APP_URL'],
        message: 'WEB_APP_URL must be https in production',
      });
  }
  if (env.META_MODE === 'live') {
    const need = [
      'META_APP_ID',
      'META_APP_SECRET',
      'META_WEBHOOK_VERIFY_TOKEN',
      'META_GRAPH_VERSION',
      'API_PUBLIC_URL',
      'COURIER_CREDENTIALS_KEY',
    ] as const;
    for (const name of need)
      if (!env[name])
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} is required when META_MODE=live`,
        });
  }
  if (Boolean(env.JWT_PRIVATE_KEY) !== Boolean(env.JWT_PUBLIC_KEY)) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_PUBLIC_KEY'],
      message: 'Set both JWT_PRIVATE_KEY and JWT_PUBLIC_KEY, or neither',
    });
  }
}

// META_MODE defaults to mock and REGISTRATION_MODE to open outside production (production must say both: checked above).
const withDefaults = (env: RawEnv) => ({
  ...env,
  META_MODE: env.META_MODE ?? ('mock' as const),
  REGISTRATION_MODE: env.REGISTRATION_MODE ?? ('open' as const),
});

/** What the API validates. */
export const ServerEnv = ServerEnvShape.superRefine((env, ctx) =>
  checkServerEnv(env, ctx, 'api'),
).transform(withDefaults);
/** What the worker validates: the same variables, without the API-only production requirements. */
export const WorkerEnv = ServerEnvShape.superRefine((env, ctx) =>
  checkServerEnv(env, ctx, 'worker'),
).transform(withDefaults);
export type ServerEnv = z.infer<typeof ServerEnv>;

/** Parse and validate process env; throws a readable error listing every bad variable. */
export function loadServerEnv(
  source: Record<string, string | undefined> = process.env,
  options: { service?: 'api' | 'worker' } = {},
): ServerEnv {
  // A variable that is set but blank (`SMTP_USER=` in an env file, or `${SMTP_USER:-}` in a Compose file) means "not set":
  // otherwise every optional setting would have to be commented out, and one stray `KEY=` stops the server from starting.
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = (options.service === 'worker' ? WorkerEnv : ServerEnv).safeParse(present);
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
