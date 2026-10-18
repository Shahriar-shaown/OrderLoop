import { Controller, Inject, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { routes, type AuthResult, type Me, type ParsedInput } from '@orderloop/contracts';
import type { Response } from 'express';
import { ApiError } from '../common/api-error.js';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { AuthService, type Issued } from './auth.service.js';

const COOKIE = 'ol_rt';
const COOKIE_PATH = '/v1/auth';
/** Credential-checking endpoints get a much tighter per-IP budget than the global default. */
const STRICT = { default: { limit: 10, ttl: 60_000 } };

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private meta(req: AppRequest) {
    return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
  }

  /** Browsers announce themselves with `x-client: web`: their refresh token travels in an HttpOnly cookie, never in JSON. */
  private isWeb(req: AppRequest): boolean {
    return req.headers['x-client'] === 'web';
  }

  private deliver(req: AppRequest, res: Response, issued: Issued): AuthResult {
    if (!this.isWeb(req) || !issued.refreshToken) return issued;
    const { refreshToken, ...body } = issued;
    res.cookie(COOKIE, refreshToken, {
      httpOnly: true,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: COOKIE_PATH,
      maxAge: this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    });
    return body;
  }

  @Endpoint(routes.register)
  @Throttle(STRICT)
  async register(
    @Input() input: ParsedInput<typeof routes.register>,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResult> {
    return this.deliver(req, res, await this.auth.register(input.body, this.meta(req)));
  }

  @Endpoint(routes.login)
  @Throttle(STRICT)
  async login(
    @Input() input: ParsedInput<typeof routes.login>,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResult> {
    return this.deliver(req, res, await this.auth.login(input.body, this.meta(req)));
  }

  @Endpoint(routes.refresh)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async refresh(
    @Input() input: ParsedInput<typeof routes.refresh>,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResult> {
    let token = input.body.refreshToken;
    if (!token && this.isWeb(req)) {
      // Cookie transport. The custom header forces a CORS preflight for cross-site callers, and the Origin must be ours.
      const origin = req.headers.origin;
      if (origin && !this.config.WEB_ORIGINS.includes(origin))
        throw ApiError.forbidden('Origin not allowed');
      token = readCookie(req.headers.cookie, COOKIE);
    }
    if (!token) throw ApiError.unauthorized('Refresh token required');
    return this.deliver(req, res, await this.auth.refresh(token, this.meta(req)));
  }

  @Endpoint(routes.logout)
  async logout(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, never>> {
    await this.auth.logout(auth, this.meta(req));
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
    return {};
  }

  @Endpoint(routes.verifyEmail)
  @Throttle(STRICT)
  async verifyEmail(
    @Input() input: ParsedInput<typeof routes.verifyEmail>,
    @Req() req: AppRequest,
  ): Promise<Record<string, never>> {
    await this.auth.verifyEmail(input.body, this.meta(req));
    return {};
  }

  @Endpoint(routes.resendVerification)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async resendVerification(@Auth() auth: AuthContext): Promise<Record<string, never>> {
    await this.auth.resendVerification(auth);
    return {};
  }

  @Endpoint(routes.forgotPassword)
  @Throttle(STRICT)
  async forgotPassword(
    @Input() input: ParsedInput<typeof routes.forgotPassword>,
  ): Promise<Record<string, never>> {
    await this.auth.forgotPassword(input.body);
    return {};
  }

  @Endpoint(routes.resetPassword)
  @Throttle(STRICT)
  async resetPassword(
    @Input() input: ParsedInput<typeof routes.resetPassword>,
    @Req() req: AppRequest,
  ): Promise<Record<string, never>> {
    await this.auth.resetPassword(input.body, this.meta(req));
    return {};
  }

  @Endpoint(routes.switchTenant)
  async switchTenant(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.switchTenant>,
    @Req() req: AppRequest,
  ): Promise<AuthResult> {
    return this.auth.switchTenant(auth, input.body.tenantId, this.meta(req));
  }

  @Endpoint(routes.acceptInvitation)
  @Throttle(STRICT)
  async acceptInvitation(
    @Input() input: ParsedInput<typeof routes.acceptInvitation>,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResult> {
    return this.deliver(req, res, await this.auth.acceptInvitation(input.body, this.meta(req)));
  }
}

@Controller()
export class AccountController {
  constructor(private readonly auth: AuthService) {}

  @Endpoint(routes.me)
  me(@Auth() auth: AuthContext): Promise<Me> {
    return this.auth.me(auth);
  }

  @Endpoint(routes.updatePreferences)
  updatePreferences(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updatePreferences>,
  ): Promise<Me> {
    return this.auth.updatePreferences(auth, input.body);
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
