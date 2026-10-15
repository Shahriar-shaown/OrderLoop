import type { ErrorCode } from '@orderloop/contracts';

/** Expected failure with a stable machine-readable code. Rendered as RFC 9457 problem details. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(detail ?? code);
    this.name = 'ApiError';
  }

  static unauthorized(detail = 'Authentication required') {
    return new ApiError(401, 'unauthorized', detail);
  }
  static invalidCredentials() {
    // One message for unknown email, wrong password and disabled account: no user enumeration.
    return new ApiError(401, 'invalid_credentials', 'Invalid email or password');
  }
  static forbidden(detail = 'You do not have permission to do this') {
    return new ApiError(403, 'forbidden', detail);
  }
  static notFound(detail = 'Not found') {
    return new ApiError(404, 'not_found', detail);
  }
  static conflict(detail: string) {
    return new ApiError(409, 'conflict', detail);
  }
}
