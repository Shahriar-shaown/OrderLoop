import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RouteSpec } from '@orderloop/contracts';
import type { Observable } from 'rxjs';
import { z } from 'zod';
import { ApiError } from './api-error.js';
import { ROUTE_SPEC, type AppRequest } from './endpoint.js';

/** Validates params, query and body against the route registry before the handler runs. */
@Injectable()
export class ValidationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.get<RouteSpec | undefined>(ROUTE_SPEC, context.getHandler());
    if (!spec) return next.handle();
    const req = context.switchToHttp().getRequest<AppRequest>();

    const errors: { path: string; message: string }[] = [];
    const parse = (where: string, schema: z.ZodType | undefined, value: unknown) => {
      if (!schema) return undefined;
      const result = schema.safeParse(value ?? {});
      if (result.success) return result.data;
      for (const issue of result.error.issues)
        errors.push({ path: [where, ...issue.path].join('.'), message: issue.message });
      return undefined;
    };

    const input = {
      params: parse('params', spec.params, req.params),
      query: parse('query', spec.query, req.query),
      body: parse('body', spec.body, req.body),
    };
    if (errors.length)
      throw new ApiError(400, 'validation_failed', 'Request validation failed', errors);
    req.input = input;
    return next.handle();
  }
}
