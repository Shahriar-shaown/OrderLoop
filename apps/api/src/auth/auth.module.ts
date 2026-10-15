import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AccessGuard } from './access.guard.js';
import { AccountController, AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import { UserTokenService } from './user-token.service.js';

@Module({
  imports: [AuditModule],
  controllers: [AuthController, AccountController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    SessionService,
    LoginThrottleService,
    UserTokenService,
    AccessGuard,
  ],
  exports: [TokenService, AccessGuard],
})
export class AuthModule {}
