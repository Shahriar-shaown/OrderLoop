import { pino, type DestinationStream, type Logger } from 'pino';
import { scrubSecrets } from './scrub.js';

export type { Logger };

/**
 * Structured fields that must never reach a log line, matched by path. We also avoid logging request or response
 * bodies at all, so this list is a second barrier against future code that logs an object carrying a credential.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  '*.authorization',
  '*.cookie',
  'password',
  '*.password',
  '*.*.password',
  'passwordHash',
  '*.passwordHash',
  '*.*.passwordHash',
  'token',
  '*.token',
  '*.*.token',
  'tokenHash',
  '*.tokenHash',
  'accessToken',
  '*.accessToken',
  '*.*.accessToken',
  'refreshToken',
  '*.refreshToken',
  '*.*.refreshToken',
  'newPassword',
  '*.newPassword',
  'currentPassword',
  '*.currentPassword',
  'secret',
  '*.secret',
  'smtpPassword',
  '*.smtpPassword',
  'privateKey',
  '*.privateKey',
  // Courier credentials and the secret a courier sends with its webhooks.
  'credentials',
  '*.credentials',
  '*.*.credentials',
  'webhookSecret',
  '*.webhookSecret',
  '*.*.webhookSecret',
  'apiKey',
  '*.apiKey',
  '*.*.apiKey',
  'secretKey',
  '*.secretKey',
  '*.*.secretKey',
  'clientSecret',
  '*.clientSecret',
  '*.*.clientSecret',
  'clientId',
  '*.clientId',
  '*.*.clientId',
  'api_key',
  '*.api_key',
  '*.*.api_key',
  'secret_key',
  '*.secret_key',
  '*.*.secret_key',
  'client_secret',
  '*.client_secret',
  '*.*.client_secret',
  'req.headers["x-pathao-signature"]',
];

export interface LoggerOptions {
  level: string;
  /** Defaults to stdout. Tests pass a capturing stream. */
  destination?: DestinationStream;
}

type ErrorLike = Error & { code?: unknown };

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: 'orderloop-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: {
        // Errors carry free text; pass it through the scrubber and drop any attached payloads.
        err: (error: ErrorLike) => ({
          type: error?.name,
          message: scrubSecrets(String(error?.message ?? '')),
          ...(error?.code !== undefined ? { code: String(error.code) } : {}),
          stack: scrubSecrets(String(error?.stack ?? '')),
        }),
      },
    },
    options.destination,
  );
}
