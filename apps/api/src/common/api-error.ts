import { ERROR_STATUS, type ErrorCode } from '@orderloop/contracts';

/** Expected failure with a stable machine-readable code. Rendered as RFC 9457 problem details. */
export class ApiError extends Error {
  /** Fixed per code (see ERROR_STATUS), so a code can never be sent with two different statuses. */
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(detail ?? code);
    this.name = 'ApiError';
    this.status = ERROR_STATUS[code];
  }

  static unauthorized(detail = 'Authentication required') {
    return new ApiError('unauthorized', detail);
  }
  static invalidCredentials() {
    // One message for unknown email, wrong password and disabled account: no user enumeration.
    return new ApiError('invalid_credentials', 'Invalid email or password');
  }
  static forbidden(detail = 'You do not have permission to do this') {
    return new ApiError('forbidden', detail);
  }
  static notFound(detail = 'Not found') {
    return new ApiError('not_found', detail);
  }
  static conflict(detail: string) {
    return new ApiError('conflict', detail);
  }
}
