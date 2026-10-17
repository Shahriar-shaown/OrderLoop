import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { ErrorCode, Problem } from '@orderloop/contracts';
import type { Response } from 'express';
import { scrubSecrets } from '../logging/scrub.js';
import { bodyParserProblem } from './body-parser-problem.js';
import { ApiError } from './api-error.js';

const STATUS_CODE: Record<number, ErrorCode> = {
  400: 'validation_failed',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'validation_failed',
  429: 'rate_limited',
};

/** Renders every error as RFC 9457 problem details. Unknown errors are logged and never leaked. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let problem: Problem;

    const bodyProblem = bodyParserProblem(exception);
    if (bodyProblem) {
      problem = bodyProblem;
    } else if (exception instanceof ApiError) {
      problem = {
        type: `urn:orderloop:error:${exception.code}`,
        title: exception.code,
        status: exception.status,
        code: exception.code,
        ...(exception.detail ? { detail: exception.detail } : {}),
        ...(exception.errors ? { errors: exception.errors } : {}),
      };
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_CODE[status] ?? 'internal_error';
      problem = {
        type: `urn:orderloop:error:${code}`,
        title: code,
        status,
        code,
        detail: status === 429 ? 'Too many requests, slow down' : exception.message,
      };
    } else {
      // Driver and library messages can echo secrets (SQL parameters, tokens): scrub before they reach any logger.
      this.logger.error(
        scrubSecrets(
          exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
        ),
      );
      problem = {
        type: 'urn:orderloop:error:internal_error',
        title: 'internal_error',
        status: 500,
        code: 'internal_error',
      };
    }

    res.status(problem.status).type('application/problem+json').json(problem);
  }
}
