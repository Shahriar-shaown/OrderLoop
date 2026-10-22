import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccountDeletionController } from './account.controller.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { ReauthService } from './reauth.service.js';
import { TenantDeletionService } from './tenant-deletion.service.js';

/** Deleting an account or a whole business. See docs/privacy-and-deletion.md. */
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [AccountDeletionController],
  providers: [AccountDeletionService, TenantDeletionService, ReauthService],
})
export class AccountModule {}
