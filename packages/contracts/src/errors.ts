import { z } from 'zod';

export const KNOWN_ERROR_CODES = [
  'validation_failed',
  'unauthorized',
  'invalid_credentials',
  'token_expired',
  'token_reuse_detected',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'invitation_invalid',
  'token_invalid',
  'email_not_verified',
  'last_owner',
  'insufficient_stock',
  'invalid_transition',
  'version_conflict',
  'idempotency_conflict',
  'courier_not_configured',
  'courier_rejected',
  'courier_unavailable',
  'courier_unsupported',
  'shipment_conflict',
  'settlement_has_issues',
  'internal_error',
] as const;
export type ErrorCode = (typeof KNOWN_ERROR_CODES)[number];
export const ErrorCode = z.enum(KNOWN_ERROR_CODES);

/** True for a code this build knows. A newer API may send others: `Problem.code` accepts any string. */
export const isKnownErrorCode = (code: string | undefined): code is ErrorCode =>
  (KNOWN_ERROR_CODES as readonly string[]).includes(code ?? '');

/** RFC 9457 problem details, plus a stable machine-readable `code`. */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  /** One of `ErrorCode`, or a code added after this build (check with `isKnownErrorCode`). */
  code: z.string(),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof Problem>;
