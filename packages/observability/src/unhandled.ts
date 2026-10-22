/**
 * The one log line an unhandled error produces, in both the API and the worker: a stable `event: "unhandled_error"` to alert
 * on, the service, where it was caught, the error's class name, a scrubbed message and the top of the stack. No request data,
 * no user ids, no emails: only what the error itself says, after the caller's secret scrubber ran over it.
 */
export interface UnhandledErrorEntry {
  time: string;
  level: 'error';
  service: string;
  event: 'unhandled_error';
  source: string;
  errorName: string;
  message: string;
  stack?: string;
}

const MAX_MESSAGE = 300;
const MAX_STACK_LINES = 8;

export function unhandledErrorEntry(
  service: string,
  source: string,
  error: unknown,
  scrub: (text: string) => string,
  now: () => Date = () => new Date(),
): UnhandledErrorEntry {
  const err = error instanceof Error ? error : undefined;
  const message = scrub(
    err ? err.message || (err as { code?: string }).code || err.name : String(error),
  ).slice(0, MAX_MESSAGE);
  const stack = err?.stack
    ? scrub(err.stack.split('\n').slice(0, MAX_STACK_LINES).join('\n'))
    : undefined;
  return {
    time: now().toISOString(),
    level: 'error',
    service,
    event: 'unhandled_error',
    source,
    errorName: err?.name ?? typeof error,
    message,
    ...(stack ? { stack } : {}),
  };
}
