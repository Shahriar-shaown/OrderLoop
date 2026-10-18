/**
 * What went wrong talking to a courier, in terms the caller can act on. Messages are written for a merchant to read and
 * never contain credentials, tokens or request bodies.
 */
export type CourierErrorKind =
  /** The provider refused the request as invalid (400/422). Fix the input; retrying cannot help. */
  | 'validation'
  /** The credentials were rejected (401). Never retried in a loop: repeated failures can lock the account. */
  | 'auth'
  /** Allowed credentials, forbidden action: inactive account, unpaid dues, missing approval (402/403). */
  | 'forbidden'
  | 'not_found'
  /** Too many requests (429), or our own limiter. Retry after a pause. */
  | 'rate_limited'
  /** Timed out, network failure, 5xx, or a reply that was not JSON. */
  | 'unavailable'
  /** Something we cannot classify. Reported, not retried. */
  | 'unexpected'
  /** The request was refused before it left (our own validation of what the provider requires). */
  | 'unsupported';

export class CourierError extends Error {
  constructor(
    readonly kind: CourierErrorKind,
    message: string,
    readonly options: {
      status?: number | undefined;
      /** Seconds the provider asked us to wait, when it said. */
      retryAfterSeconds?: number | undefined;
      /**
       * The request may or may not have been carried out. For a booking this is the dangerous case: the parcel might exist.
       * Never retry a booking blindly when this is true.
       */
      outcomeUnknown?: boolean | undefined;
      /** Field-level problems the provider reported. */
      fields?: { field: string; message: string }[] | undefined;
    } = {},
  ) {
    super(message);
    this.name = 'CourierError';
  }

  get status(): number | undefined {
    return this.options.status;
  }
  get outcomeUnknown(): boolean {
    return this.options.outcomeUnknown ?? false;
  }
  get retryAfterSeconds(): number | undefined {
    return this.options.retryAfterSeconds;
  }
  get fields(): { field: string; message: string }[] {
    return this.options.fields ?? [];
  }
  /** Worth trying again later (for an idempotent request). */
  get retryable(): boolean {
    return this.kind === 'unavailable' || this.kind === 'rate_limited';
  }
}
