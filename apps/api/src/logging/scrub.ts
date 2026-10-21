export { scrubSecrets } from '@orderloop/automation';

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A request path that is safe to log. Ids (UUIDs) are kept, for tracing; the one path that carries a credential-like value
 * (`/v1/push-devices/:token`) and any other long opaque segment (a token in a future route) are replaced. Static route words
 * are far shorter than 20 characters.
 */
export function scrubPath(path: string): string {
  return path
    .replace(/^(\/v1\/push-devices\/)[^/]+/i, '$1[REDACTED]')
    .split('/')
    .map((segment) =>
      segment.length >= 20 && !UUID_SEGMENT.test(segment) ? '[REDACTED]' : segment,
    )
    .join('/');
}
