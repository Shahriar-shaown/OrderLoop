import { scrubSecrets } from '@orderloop/automation';

/**
 * An error as one log-safe line. Connection failures surface as AggregateError with an empty message, so this falls back to the
 * code or the errors inside. Always passed through scrubSecrets: a driver error can quote a connection string, a statement or a
 * token, and the worker's console is a log sink like any other.
 */
export function describe(err: Error & { code?: string; errors?: Error[] }): string {
  return scrubSecrets(
    err.message ||
      err.code ||
      err.errors?.map((e) => e.message || (e as { code?: string }).code).join(', ') ||
      err.name,
  );
}
