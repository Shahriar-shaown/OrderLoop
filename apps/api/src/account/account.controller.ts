import { Controller, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  routes,
  type DeleteAccountResult,
  type ParsedInput,
  type TenantDeletionStatus,
} from '@orderloop/contracts';
import type { Response } from 'express';
import { COOKIE, COOKIE_PATH } from '../auth/auth.controller.js';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { TenantDeletionService } from './tenant-deletion.service.js';

/** Irreversible actions that check a password get the same tight per-IP budget as signing in. */
const STRICT = { default: { limit: 10, ttl: 60_000 } };

@Controller()
export class AccountDeletionController {
  constructor(
    private readonly accounts: AccountDeletionService,
    private readonly tenants: TenantDeletionService,
  ) {}

  @Endpoint(routes.deleteAccount)
  @Throttle(STRICT)
  async deleteAccount(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.deleteAccount>,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeleteAccountResult> {
    const result = await this.accounts.deleteAccount(auth, input.body, req.ip ?? null);
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
    return result;
  }

  @Endpoint(routes.tenantDeletionStatus)
  deletionStatus(@Auth() auth: AuthContext): Promise<TenantDeletionStatus> {
    return this.tenants.current(auth);
  }

  @Endpoint(routes.requestTenantDeletion)
  @Throttle(STRICT)
  requestDeletion(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.requestTenantDeletion>,
    @Req() req: AppRequest,
  ): Promise<TenantDeletionStatus> {
    return this.tenants.request(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.cancelTenantDeletion)
  cancelDeletion(@Auth() auth: AuthContext, @Req() req: AppRequest): Promise<TenantDeletionStatus> {
    return this.tenants.cancel(auth, req.ip ?? null);
  }
}
