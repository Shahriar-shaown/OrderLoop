import { Controller, Inject, Req, Res } from '@nestjs/common';
import {
  routes,
  type ConnectPagesResult,
  type ConfirmDraftResult,
  type MetaOverview,
  type MockEventResult,
  type OauthSession,
  type OauthStartResult,
  type ParsedInput,
  type SocialConnection,
  type SocialDraft,
  type SocialDraftPage,
} from '@orderloop/contracts';
import type { Response } from 'express';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { ConnectionsService } from './connections.service.js';
import { DraftsService } from './drafts.service.js';
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, OauthService } from './oauth.service.js';

/** The value of one cookie from a Cookie header (the API does not use cookie-parser: this is its only cookie). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function cookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.NODE_ENV === 'production',
    path: OAUTH_COOKIE_PATH,
  };
}

@Controller()
export class MetaController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly connections: ConnectionsService,
    private readonly oauth: OauthService,
    private readonly drafts: DraftsService,
  ) {}

  @Endpoint(routes.getMetaOverview)
  overview(@Auth() auth: AuthContext): Promise<MetaOverview> {
    return this.connections.overview(auth);
  }

  @Endpoint(routes.startMetaOauth)
  start(@Auth() auth: AuthContext): Promise<OauthStartResult> {
    return this.oauth.start(auth);
  }

  @Endpoint(routes.metaOauthBegin)
  async begin(
    @Input() input: ParsedInput<typeof routes.metaOauthBegin>,
    @Res() res: Response,
  ): Promise<void> {
    const { redirect, cookie } = await this.oauth.begin(input.query.ticket);
    // HttpOnly, SameSite=Lax (sent on Meta's top-level redirect back), Secure in production, scoped to the OAuth routes.
    if (cookie)
      res.cookie(OAUTH_COOKIE, cookie.value, {
        ...cookieOptions(this.config),
        maxAge: cookie.maxAgeMs,
      });
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, redirect);
  }

  @Endpoint(routes.metaOauthCallback)
  async callback(
    @Input() input: ParsedInput<typeof routes.metaOauthCallback>,
    @Req() req: AppRequest,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.oauth.callback(
      input.query,
      readCookie(req.headers.cookie, OAUTH_COOKIE),
    );
    // Single use: the cookie goes whatever the outcome.
    res.clearCookie(OAUTH_COOKIE, cookieOptions(this.config));
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, target);
  }

  @Endpoint(routes.getMetaOauthSession)
  session(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getMetaOauthSession>,
  ): Promise<OauthSession> {
    return this.oauth.session(auth, input.params.id);
  }

  @Endpoint(routes.connectMetaPages)
  connect(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.connectMetaPages>,
    @Req() req: AppRequest,
  ): Promise<ConnectPagesResult> {
    return this.oauth.connect(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.disconnectMetaConnection)
  disconnect(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.disconnectMetaConnection>,
    @Req() req: AppRequest,
  ): Promise<SocialConnection> {
    return this.connections.disconnect(auth, input.params.id, req.ip ?? null);
  }

  @Endpoint(routes.reconnectMetaConnection)
  reconnect(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.reconnectMetaConnection>,
  ): Promise<OauthStartResult> {
    return this.oauth.start(auth, input.params.id);
  }

  @Endpoint(routes.createMockMetaConnection)
  mockConnection(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.createMockMetaConnection>,
    @Req() req: AppRequest,
  ): Promise<SocialConnection> {
    return this.connections.createMockConnection(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.injectMockMetaEvent)
  mockEvent(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.injectMockMetaEvent>,
  ): Promise<MockEventResult> {
    return this.connections.injectMockEvent(auth, input.body);
  }

  // ---- drafts ---------------------------------------------------------------------------------------------------------

  @Endpoint(routes.listSocialDrafts)
  list(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listSocialDrafts>,
  ): Promise<SocialDraftPage> {
    return this.drafts.list(auth, input.query);
  }

  @Endpoint(routes.getSocialDraft)
  get(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getSocialDraft>,
  ): Promise<SocialDraft> {
    return this.drafts.get(auth, input.params.id);
  }

  @Endpoint(routes.updateSocialDraft)
  update(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateSocialDraft>,
  ): Promise<SocialDraft> {
    return this.drafts.update(auth, input.params.id, input.body);
  }

  @Endpoint(routes.confirmSocialDraft)
  confirm(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.confirmSocialDraft>,
    @Req() req: AppRequest,
  ): Promise<ConfirmDraftResult> {
    return this.drafts.confirm(auth, input.params.id, input.body, req.ip ?? null);
  }

  @Endpoint(routes.dismissSocialDraft)
  dismiss(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.dismissSocialDraft>,
    @Req() req: AppRequest,
  ): Promise<SocialDraft> {
    return this.drafts.dismiss(auth, input.params.id, input.body, req.ip ?? null);
  }
}
