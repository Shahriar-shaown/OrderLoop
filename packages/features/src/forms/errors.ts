import { ApiError } from '@orderloop/api-client';
import type { z } from 'zod';

/** What went wrong with Meta, and what to do about it. Also used for a Page that could not be connected. */
export function metaErrorText(code: string, fallback?: string): string {
  switch (code) {
    case 'meta_not_configured':
      return 'Connecting to Meta is not set up on this server. Ask whoever runs the server to set it up.';
    case 'meta_oauth_invalid':
      return 'The sign-in with Meta expired or is not valid. Start the connection again.';
    case 'meta_permission_denied':
      return 'Meta did not give OrderLoop every permission it needs, or you cannot manage that Page. Try again and approve every permission.';
    case 'meta_instagram_not_linked':
      return 'That Instagram account is not a professional account linked to a Facebook Page.';
    case 'meta_messages_access_off':
      return 'Turn on “Allow access to messages” in the Instagram settings (Messages and story replies, Connected tools), then try again.';
    case 'meta_token_invalid':
      return 'Meta did not accept the sign-in. Try connecting again.';
    case 'meta_unavailable':
      return 'Meta could not be reached. Try again in a few minutes.';
    case 'conflict':
      return 'That account is already connected to another business. Disconnect it there first.';
    default:
      return fallback ?? 'This account could not be connected. Try again.';
  }
}

/** Couriers take whole taka only and a confirmed order cannot be edited, so paisa in the cash to collect must be fixed first. */
export const COD_PAISA_ADVICE =
  'Couriers take whole taka only, so this order cannot be booked with a courier: its cash to collect has paisa. Cancel the order and enter it again with prices, discount and delivery charge that make the cash to collect a whole number of taka.';

export const REGISTRATION_CLOSED =
  'Sign-up is closed for now. Ask the person who invited you to send an invitation, or contact support.';

/** Does the cash to collect on this order have paisa? The API says so; older replies are worked out from the amount. */
export const hasPaisa = (order: { codHasPaisa?: boolean | undefined; codAmountMinor: number }) =>
  order.codHasPaisa ?? order.codAmountMinor % 100 !== 0;

/** A message a person can act on, for any failure. Never shows raw server internals. */
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Incorrect email or password.';
      case 'rate_limited':
        return error.message || 'Too many attempts. Wait a little and try again.';
      case 'offline':
        return error.message;
      case 'invalid_response':
      case 'unexpected_response':
        // The server answered, but not in the shape this app expects: the two are different versions.
        return 'This app and the server are out of step. Update the app, or ask whoever runs the server to update it.';
      case 'network_error':
        return 'Cannot reach the server. Check your connection and try again.';
      case 'request_timeout':
        // Worded by the client: "safe to try again" when the request carried an idempotency key, "check first" when not.
        return error.message;
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
      case 'channel_not_configured':
        return 'This server cannot send that kind of message yet. Turn the channel off, or ask whoever runs the server to set it up.';
      case 'consent_required':
        return 'Nobody who would get this alert has agreed to SMS or WhatsApp yet. Each person agrees in Notification preferences first.';
      case 'idempotency_conflict':
        return 'This was already sent with different details. Close this form and check the list before adding it again.';
      case 'courier_unsupported':
        // The booking refusal for paisa is worded for the person here (and translated); other refusals carry their own words.
        return /has paisa/.test(error.message) ? COD_PAISA_ADVICE : error.message;
      case 'registration_closed':
        return REGISTRATION_CLOSED;
      case 'draft_closed':
        return 'This draft was already confirmed or dismissed. Reload to see what happened.';
      case 'meta_not_configured':
      case 'meta_oauth_invalid':
      case 'meta_permission_denied':
      case 'meta_instagram_not_linked':
      case 'meta_messages_access_off':
      case 'meta_token_invalid':
      case 'meta_unavailable':
        return metaErrorText(error.code);
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
  // Browsers strip tabs and newlines inside URLs and treat `\` as `/`, so `/\t/evil.com` would mean `//evil.com`.
  if (!next || !/^\/(?![/\\])/.test(next) || /[\u0000-\u0020\u007f\\]/.test(next)) return fallback;
  try {
    const base = new URL('https://safe.invalid');
    const url = new URL(next, base);
    if (url.origin !== base.origin) return fallback;
  } catch {
    return fallback;
  }
  return next;
}
