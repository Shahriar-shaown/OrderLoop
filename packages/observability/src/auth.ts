import { timingSafeEqual, createHash } from 'node:crypto';

/** What a guarded /metrics request gets. `disabled` is answered 404 (the endpoint does not exist), the others 401. */
export type MetricsAuthResult = 'ok' | 'disabled' | 'missing' | 'invalid';

/**
 * Checks `Authorization: Bearer <token>` against the configured token in constant time (both sides hashed first, so the
 * comparison length does not depend on the secret). With no token configured the endpoint is disabled.
 */
export function checkMetricsAuth(
  configuredToken: string | undefined,
  authorizationHeader: string | string[] | undefined,
): MetricsAuthResult {
  if (!configuredToken) return 'disabled';
  const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (!header) return 'missing';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return 'invalid';
  const a = createHash('sha256').update(match[1]!).digest();
  const b = createHash('sha256').update(configuredToken).digest();
  return timingSafeEqual(a, b) ? 'ok' : 'invalid';
}

export function statusFor(result: MetricsAuthResult): number {
  return result === 'ok' ? 200 : result === 'disabled' ? 404 : 401;
}
