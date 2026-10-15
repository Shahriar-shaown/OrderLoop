import { Injectable, type LoggerService } from '@nestjs/common';
import type { Logger } from './logger.js';
import { scrubSecrets } from './scrub.js';

/** Routes Nest's own logging (and every `new Logger(...)` in the app) through the structured, redacting pino logger. */
@Injectable()
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace',
    message: unknown,
    context?: string,
    stack?: string,
  ) {
    const text = typeof message === 'string' ? scrubSecrets(message) : message;
    const fields = {
      ...(context ? { context } : {}),
      ...(stack ? { stack: scrubSecrets(stack) } : {}),
    };
    if (typeof text === 'string') this.logger[level](fields, text);
    else this.logger[level]({ ...fields, ...(text as object) }, 'log');
  }

  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, stackOrContext?: string, context?: string) {
    // Nest passes (message, stack, context) for exceptions and (message, context) otherwise.
    if (context !== undefined || (stackOrContext && stackOrContext.includes('\n')))
      this.write('error', message, context, stackOrContext);
    else this.write('error', message, stackOrContext);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.write('trace', message, context);
  }
}
