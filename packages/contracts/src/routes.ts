import { z } from 'zod';
import {
  AcceptInvitationBody,
  AuditPage,
  AuditQuery,
  AuthResult,
  Empty,
  IdParam,
  Invitation,
  InvitationSummary,
  InviteBody,
  LoginBody,
  Me,
  Member,
  RefreshBody,
  RegisterBody,
  SwitchTenantBody,
  TenantInfo,
  UpdateMemberBody,
  type Permission,
} from './auth.js';
import { LiveResponse, ReadyResponse } from './health.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RouteSpec {
  /** Stable operation id; also the OpenAPI operationId. */
  id: string;
  method: HttpMethod;
  /** Express-style path with `:param` segments. */
  path: string;
  summary: string;
  /** `public` needs no token; `access` needs a valid access token. */
  auth: 'public' | 'access';
  /** Permission the caller's role must grant (only meaningful when auth is `access`). */
  permission?: Permission;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  /** Success status. Defaults to 200. */
  status?: number;
}

function route<const T extends RouteSpec>(spec: T): T {
  return spec;
}

/**
 * Single source of truth for the HTTP API. The NestJS controllers, the typed client and the OpenAPI
 * document are all derived from this table, so they cannot drift apart.
 */
export const routes = {
  healthLive: route({
    id: 'healthLive',
    method: 'GET',
    path: '/health/live',
    summary: 'Liveness probe',
    auth: 'public',
    response: LiveResponse,
  }),
  healthReady: route({
    id: 'healthReady',
    method: 'GET',
    path: '/health/ready',
    summary: 'Readiness probe (PostgreSQL, Redis). 503 when degraded',
    auth: 'public',
    response: ReadyResponse,
  }),

  openapi: route({
    id: 'openapi',
    method: 'GET',
    path: '/openapi.json',
    summary: 'This API described as OpenAPI 3.1 (generated from the route registry)',
    auth: 'public',
    response: z.record(z.string(), z.unknown()),
  }),

  register: route({
    id: 'register',
    method: 'POST',
    path: '/v1/auth/register',
    summary: 'Create a user and a new tenant they own',
    auth: 'public',
    body: RegisterBody,
    response: AuthResult,
    status: 201,
  }),
  login: route({
    id: 'login',
    method: 'POST',
    path: '/v1/auth/login',
    summary: 'Sign in with email and password',
    auth: 'public',
    body: LoginBody,
    response: AuthResult,
  }),
  refresh: route({
    id: 'refresh',
    method: 'POST',
    path: '/v1/auth/refresh',
    summary: 'Exchange a refresh token for a new access and refresh token (rotation)',
    auth: 'public',
    body: RefreshBody,
    response: AuthResult,
  }),
  logout: route({
    id: 'logout',
    method: 'POST',
    path: '/v1/auth/logout',
    summary: 'Revoke the current session',
    auth: 'access',
    response: Empty,
  }),
  switchTenant: route({
    id: 'switchTenant',
    method: 'POST',
    path: '/v1/auth/switch-tenant',
    summary: 'Re-scope the session to another tenant the user belongs to',
    auth: 'access',
    body: SwitchTenantBody,
    response: AuthResult,
  }),
  acceptInvitation: route({
    id: 'acceptInvitation',
    method: 'POST',
    path: '/v1/auth/accept-invitation',
    summary: 'Accept a tenant invitation (creates the account if needed)',
    auth: 'public',
    body: AcceptInvitationBody,
    response: AuthResult,
    status: 201,
  }),

  me: route({
    id: 'me',
    method: 'GET',
    path: '/v1/me',
    summary: 'Current user, tenant, role and permissions',
    auth: 'access',
    response: Me,
  }),
  tenant: route({
    id: 'tenant',
    method: 'GET',
    path: '/v1/tenant',
    summary: 'Current tenant',
    auth: 'access',
    permission: 'tenant:read',
    response: TenantInfo,
  }),

  listMembers: route({
    id: 'listMembers',
    method: 'GET',
    path: '/v1/members',
    summary: 'List members of the current tenant',
    auth: 'access',
    permission: 'members:read',
    response: z.array(Member),
  }),
  inviteMember: route({
    id: 'inviteMember',
    method: 'POST',
    path: '/v1/members/invitations',
    summary: 'Invite someone by email',
    auth: 'access',
    permission: 'members:invite',
    body: InviteBody,
    response: Invitation,
    status: 201,
  }),
  listInvitations: route({
    id: 'listInvitations',
    method: 'GET',
    path: '/v1/members/invitations',
    summary: 'List pending invitations for the current tenant',
    auth: 'access',
    permission: 'members:invite',
    response: z.array(InvitationSummary),
  }),
  revokeInvitation: route({
    id: 'revokeInvitation',
    method: 'DELETE',
    path: '/v1/members/invitations/:id',
    summary: 'Revoke a pending invitation',
    auth: 'access',
    permission: 'members:invite',
    params: IdParam,
    response: Empty,
  }),
  updateMember: route({
    id: 'updateMember',
    method: 'PATCH',
    path: '/v1/members/:id',
    summary: 'Change a member role',
    auth: 'access',
    permission: 'members:manage',
    params: IdParam,
    body: UpdateMemberBody,
    response: Member,
  }),
  removeMember: route({
    id: 'removeMember',
    method: 'DELETE',
    path: '/v1/members/:id',
    summary: 'Remove a member from the tenant',
    auth: 'access',
    permission: 'members:manage',
    params: IdParam,
    response: Empty,
  }),

  listAuditLogs: route({
    id: 'listAuditLogs',
    method: 'GET',
    path: '/v1/audit-logs',
    summary: 'Audit trail for the current tenant (newest first, cursor paginated)',
    auth: 'access',
    permission: 'audit:read',
    query: AuditQuery,
    response: AuditPage,
  }),
} as const;

export type Routes = typeof routes;
export type RouteName = keyof Routes;

type Part<K extends string, S> = S extends z.ZodType ? { [P in K]: z.input<S> } : unknown;
type PartOut<K extends string, S> = S extends z.ZodType ? { [P in K]: z.output<S> } : unknown;
/** Request input for a route: only the sections the route defines. */
export type RouteInput<R extends RouteSpec> = Part<'params', R['params']> &
  Part<'query', R['query']> &
  Part<'body', R['body']>;
/** Request data after validation and defaults (what a controller receives). */
export type ParsedInput<R extends RouteSpec> = PartOut<'params', R['params']> &
  PartOut<'query', R['query']> &
  PartOut<'body', R['body']>;
export type RouteOutput<R extends RouteSpec> = z.output<R['response']>;
