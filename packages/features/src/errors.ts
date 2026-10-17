import { ApiError } from '@orderloop/api-client';
import type { z } from 'zod';

/** A message a person can act on, for any failure. Never shows raw server internals. */
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Incorrect email or password.';
      case 'rate_limited':
        return error.message || 'Too many attempts. Wait a little and try again.';
      case 'network_error':
        return 'Cannot reach the server. Check your connection and try again.';
      case 'token_invalid':
        return 'This link is invalid or has expired. Request a new one.';
      case 'invitation_invalid':
        return 'This invitation is invalid or has expired. Ask for a new one.';
      case 'email_not_verified':
        return 'Verify your email address first.';
      case 'forbidden':
        return 'You do not have permission to do that.';
      case 'unauthorized':
      case 'token_expired':
      case 'token_reuse_detected':
        return 'Your session has ended. Sign in again.';
      case 'validation_failed':
        return error.errors?.length ? 'Please fix the highlighted fields.' : error.message;
      case 'conflict':
      case 'insufficient_stock':
      case 'last_owner':
      case 'not_found':
        return error.message;
      default:
        return error.status && error.status >= 500
          ? 'Something went wrong on our side. Try again in a moment.'
          : error.message;
    }
  }
  return 'Something went wrong. Try again.';
}

/** Field errors from an API validation failure, keyed by field path without the `body.` prefix, e.g. `variants.0.sku`. */
export function fieldErrorsFrom(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !error.errors) return {};
  const out: Record<string, string> = {};
  for (const e of error.errors) {
    const key = e.path.replace(/^(body|query|params)\./, '');
    out[key] ??= e.message;
  }
  return out;
}

export type FormErrors = Record<string, string>;

/** Validate form values with a contracts schema, so the browser and the API apply identical rules. */
export function validate<S extends z.ZodType>(
  schema: S,
  values: unknown,
): { data: z.output<S>; errors: null } | { data: null; errors: FormErrors } {
  const result = schema.safeParse(values);
  if (result.success) return { data: result.data, errors: null };
  const errors: FormErrors = {};
  for (const issue of result.error.issues) errors[issue.path.join('.')] ??= issue.message;
  return { data: null, errors };
}

/** Only same-site relative paths may be used as a post-login destination (blocks open-redirect links). */
export function safeNext(next: string | null | undefined, fallback = '/products'): string {
  if (
    !next ||
    !next.startsWith('/') ||
    next.startsWith('//') ||
    next.startsWith('/\\') ||
    /[\r\n]/.test(next)
  )
    return fallback;
  return next;
}
