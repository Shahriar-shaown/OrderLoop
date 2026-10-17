import type { Problem } from '@orderloop/contracts';

/**
 * Errors raised by the JSON body parser (an http-errors object with a `type` such as entity.too.large) never reach a
 * controller. Answer them with clear, generic problem details: the raw parser message can quote the request body.
 */
export function bodyParserProblem(exception: unknown): Problem | null {
  const e = exception as { type?: unknown; status?: unknown; statusCode?: unknown } | null;
  const type = typeof e?.type === 'string' ? e.type : undefined;
  const status = Number(e?.status ?? e?.statusCode);
  if (!type || !(status >= 400 && status < 500)) return null;
  if (!/^(entity|request|encoding|charset|parameters|stream)\./.test(type)) return null;
  const detail =
    type === 'entity.too.large'
      ? 'The request body is too large'
      : type === 'entity.parse.failed'
        ? 'The request body is not valid JSON'
        : 'The request body could not be read';
  return {
    type: 'urn:orderloop:error:validation_failed',
    title: 'validation_failed',
    status,
    code: 'validation_failed',
    detail,
  };
}
