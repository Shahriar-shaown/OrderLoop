import 'reflect-metadata';
import { HttpException, Logger, type ArgumentsHost, type LoggerService } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from './api-error.js';
import { ProblemFilter } from './problem.filter.js';

function run(exception: unknown) {
  const sent: { status?: number; type?: string; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    type(t: string) {
      sent.type = t;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  new ProblemFilter().catch(exception, {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost);
  return sent;
}

const logged: string[] = [];
const capture: LoggerService = {
  log: (m) => logged.push(String(m)),
  error: (m) => logged.push(String(m)),
  warn: (m) => logged.push(String(m)),
};
afterEach(() => {
  Logger.overrideLogger(['log', 'error', 'warn']);
  logged.length = 0;
});

describe('ProblemFilter', () => {
  it('renders ApiError as RFC 9457 problem details', () => {
    const out = run(new ApiError('conflict', 'already exists'));
    expect(out.status).toBe(409);
    expect(out.type).toBe('application/problem+json');
    expect(out.body).toEqual({
      type: 'urn:orderloop:error:conflict',
      title: 'conflict',
      status: 409,
      code: 'conflict',
      detail: 'already exists',
    });
  });

  it('maps framework HTTP errors onto stable codes', () => {
    expect((run(new HttpException('nope', 429)).body as { code: string }).code).toBe(
      'rate_limited',
    );
    expect((run(new HttpException('nope', 404)).body as { code: string }).code).toBe('not_found');
  });

  it('never leaks internals to the client for unexpected errors', () => {
    Logger.overrideLogger(capture);
    const out = run(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2hunter2'));
    expect(out.status).toBe(500);
    expect(out.body).toEqual({
      type: 'urn:orderloop:error:internal_error',
      title: 'internal_error',
      status: 500,
      code: 'internal_error',
    });
  });

  it('scrubs secrets out of unexpected errors before logging them, independently of the logger in use', () => {
    Logger.overrideLogger(capture);
    const jwt = `eyJhbGciOiJFZERTQSJ9.${'a'.repeat(30)}.${'b'.repeat(20)}`;
    run(
      new Error(`boom while handling Bearer ${'x'.repeat(40)} jwt=${jwt} password=hunter2hunter2`),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('boom while handling');
    for (const leak of ['x'.repeat(40), jwt, 'hunter2hunter2'])
      expect(logged[0]).not.toContain(leak);
  });
});
