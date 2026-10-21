import {
  applyDecorators,
  createParamDecorator,
  HttpCode,
  RequestMapping,
  RequestMethod,
  SetMetadata,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { RouteSpec } from '@orderloop/contracts';
import type { Request } from 'express';

export const ROUTE_SPEC = 'orderloop:route-spec';

const METHODS = {
  GET: RequestMethod.GET,
  POST: RequestMethod.POST,
  PUT: RequestMethod.PUT,
  PATCH: RequestMethod.PATCH,
  DELETE: RequestMethod.DELETE,
} as const;

/** Bind a controller method to an entry of the shared route registry (path, verb, status, auth, permission). */
export function Endpoint(spec: RouteSpec): MethodDecorator {
  return applyDecorators(
    RequestMapping({ method: METHODS[spec.method], path: spec.path }),
    HttpCode(spec.status ?? 200),
    SetMetadata(ROUTE_SPEC, spec),
  );
}

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: import('@orderloop/contracts').Role;
  sessionId: string;
}

export interface RequestInput {
  params: unknown;
  query: unknown;
  body: unknown;
}

export type AppRequest = Request & { input?: RequestInput; auth?: AuthContext };

/** Validated `{ params, query, body }` for the matched route (see ValidationInterceptor). */
export const Input = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().input,
);

/** The authenticated caller. Only available on routes with `auth: 'access'`. */
export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const auth = ctx.switchToHttp().getRequest<AppRequest>().auth;
  if (!auth) throw new Error('Auth() used on a route that is not authenticated');
  return auth;
});
