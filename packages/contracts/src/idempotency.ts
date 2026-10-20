import { z } from 'zod';

/**
 * Sent with a create so that a retry or a double submit cannot make a second one: the same key with the same body returns
 * the first result, with a different body it is 409 idempotency_conflict. Generate one per attempt (a uuid is fine).
 */
export const IdempotencyKey = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits and . _ : -');

/** The optional field added to the body of every create that supports a key. */
export const OptionalIdempotencyKey = { idempotencyKey: IdempotencyKey.optional() };
