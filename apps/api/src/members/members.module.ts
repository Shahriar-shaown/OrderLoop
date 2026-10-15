import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
