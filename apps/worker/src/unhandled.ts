import { scrubSecrets } from '@orderloop/automation';
import { unhandledErrorEntry } from '@orderloop/observability';

/**
 * One JSON line on stderr with the stable `event: "unhandled_error"` (the line to alert on, docs/operations/monitoring.md): the
 * error's class, a scrubbed message and the top of the stack. No job data, no ids.
 */
export function logUnhandled(
  source: string,
  error: unknown,
  write: (line: string) => void = (l) => console.error(l),
): void {
  write(JSON.stringify(unhandledErrorEntry('orderloop-worker', source, error, scrubSecrets)));
}

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
