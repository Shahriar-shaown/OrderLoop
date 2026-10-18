import { z } from 'zod';

export const ErrorCode = z.enum([
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
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** RFC 9457 problem details, plus a stable machine-readable `code`. */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: ErrorCode,
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof Problem>;
