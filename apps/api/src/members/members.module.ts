import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ConsoleInviteSender, InviteSender, UnconfiguredInviteSender } from './invite-sender.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [MembersController],
  providers: [
    MembersService,
    {
      provide: InviteSender,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.NODE_ENV === 'production'
          ? new UnconfiguredInviteSender()
          : new ConsoleInviteSender(),
    },
  ],
})
export class MembersModule {}
