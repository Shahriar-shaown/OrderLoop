import { unhandledErrorEntry } from '@orderloop/observability';
import { scrubSecrets } from './scrub.js';

/**
 * One JSON line on stderr: `{"event":"unhandled_error","service":"orderloop-api","source":...}`. This is the line to alert on
 * (docs/operations/monitoring.md). It carries the error's class, a scrubbed message and the top of the stack, nothing about the
 * request or the user. Written with console.error, not the pino logger, so it still works when the logger itself failed to start.
 */
export function logUnhandled(
  source: string,
  error: unknown,
  write: (line: string) => void = (l) => console.error(l),
): void {
  write(JSON.stringify(unhandledErrorEntry('orderloop-api', source, error, scrubSecrets)));
}

/** Last-resort handlers: log with the stable event, then exit non-zero so the supervisor restarts the process. */
export function installProcessErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    logUnhandled('uncaughtException', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logUnhandled('unhandledRejection', reason);
    process.exit(1);
  });
}
