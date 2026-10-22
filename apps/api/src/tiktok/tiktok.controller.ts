import { Controller, Inject, Req, Res } from '@nestjs/common';
import {
  routes,
  type ConnectTikTokShopsResult,
  type ParsedInput,
  type TikTokConnection,
  type TikTokMockResult,
  type TikTokOauthSession,
  type TikTokOauthStartResult,
  type TikTokOrder,
  type TikTokOrderPage,
  type TikTokOverview,
  type TikTokSkuLinkPage,
  type TikTokSyncResult,
  type UpdateTikTokSkuLinkResult,
} from '@orderloop/contracts';
import type { Response } from 'express';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { readCookie } from '../meta/meta.controller.js';
import { TikTokConnectionsService } from './connections.service.js';
import { TikTokMockService } from './mock.service.js';
import {
  TIKTOK_OAUTH_COOKIE,
  TIKTOK_OAUTH_COOKIE_PATH,
  TikTokOauthService,
} from './oauth.service.js';
import { TikTokOrdersService } from './orders.service.js';
import { TikTokSkuLinksService } from './sku-links.service.js';

function cookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.NODE_ENV === 'production',
    path: TIKTOK_OAUTH_COOKIE_PATH,
  };
}

@Controller()
export class TikTokController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly connections: TikTokConnectionsService,
    private readonly oauth: TikTokOauthService,
    private readonly mock: TikTokMockService,
    private readonly orders: TikTokOrdersService,
    private readonly skuLinks: TikTokSkuLinksService,
  ) {}

  @Endpoint(routes.getTikTokOverview)
  overview(@Auth() auth: AuthContext): Promise<TikTokOverview> {
    return this.connections.overview(auth);
  }

  @Endpoint(routes.startTikTokOauth)
  start(@Auth() auth: AuthContext): Promise<TikTokOauthStartResult> {
    return this.oauth.start(auth);
  }

  @Endpoint(routes.tiktokOauthBegin)
  async begin(
    @Input() input: ParsedInput<typeof routes.tiktokOauthBegin>,
    @Res() res: Response,
  ): Promise<void> {
    const { redirect, cookie } = await this.oauth.begin(input.query.ticket);
    // HttpOnly, SameSite=Lax (sent on TikTok's top-level redirect back), Secure in production, scoped to the OAuth routes.
    if (cookie)
      res.cookie(TIKTOK_OAUTH_COOKIE, cookie.value, {
        ...cookieOptions(this.config),
        maxAge: cookie.maxAgeMs,
      });
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, redirect);
  }

  @Endpoint(routes.tiktokOauthCallback)
  async callback(
    @Input() input: ParsedInput<typeof routes.tiktokOauthCallback>,
    @Req() req: AppRequest,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.oauth.callback(
      input.query,
      readCookie(req.headers.cookie, TIKTOK_OAUTH_COOKIE),
    );
    // Single use: the cookie goes whatever the outcome.
    res.clearCookie(TIKTOK_OAUTH_COOKIE, cookieOptions(this.config));
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, target);
  }

  @Endpoint(routes.getTikTokOauthSession)
  session(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getTikTokOauthSession>,
  ): Promise<TikTokOauthSession> {
    return this.oauth.session(auth, input.params.id);
  }

  @Endpoint(routes.connectTikTokShops)
  connect(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.connectTikTokShops>,
    @Req() req: AppRequest,
  ): Promise<ConnectTikTokShopsResult> {
    return this.oauth.connect(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.disconnectTikTokConnection)
  disconnect(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.disconnectTikTokConnection>,
    @Req() req: AppRequest,
  ): Promise<TikTokConnection> {
    return this.connections.disconnect(auth, input.params.id, req.ip ?? null);
  }

  @Endpoint(routes.reconnectTikTokConnection)
  reconnect(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.reconnectTikTokConnection>,
  ): Promise<TikTokOauthStartResult> {
    return this.oauth.start(auth, input.params.id);
  }

  @Endpoint(routes.syncTikTokConnection)
  sync(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.syncTikTokConnection>,
  ): Promise<TikTokSyncResult> {
    return this.connections.sync(auth, input.params.id);
  }

  @Endpoint(routes.createMockTikTokConnection)
  mockConnection(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.createMockTikTokConnection>,
    @Req() req: AppRequest,
  ): Promise<TikTokConnection> {
    return this.connections.createMockConnection(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.injectMockTikTokOrder)
  mockOrder(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.injectMockTikTokOrder>,
  ): Promise<TikTokMockResult> {
    return this.mock.injectOrder(auth, input.body);
  }

  @Endpoint(routes.changeMockTikTokOrderStatus)
  mockStatus(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.changeMockTikTokOrderStatus>,
  ): Promise<TikTokMockResult> {
    return this.mock.changeStatus(auth, input.params.id, input.body);
  }

  // ---- mirrored orders and SKU links -------------------------------------------------------------------------------------

  @Endpoint(routes.listTikTokOrders)
  listOrders(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listTikTokOrders>,
  ): Promise<TikTokOrderPage> {
    return this.orders.list(auth, input.query);
  }

  @Endpoint(routes.getTikTokOrder)
  getOrder(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getTikTokOrder>,
  ): Promise<TikTokOrder> {
    return this.orders.get(auth, input.params.id);
  }

  @Endpoint(routes.listTikTokSkuLinks)
  listSkuLinks(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listTikTokSkuLinks>,
  ): Promise<TikTokSkuLinkPage> {
    return this.skuLinks.list(auth, input.query);
  }

  @Endpoint(routes.updateTikTokSkuLink)
  updateSkuLink(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateTikTokSkuLink>,
    @Req() req: AppRequest,
  ): Promise<UpdateTikTokSkuLinkResult> {
    return this.skuLinks.update(auth, input.params.id, input.body, req.ip ?? null);
  }
}
