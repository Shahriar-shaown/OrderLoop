import { Injectable } from '@nestjs/common';
import { Database } from '@orderloop/db';
import { LoginThrottleService } from '../auth/login-throttle.service.js';
import { PasswordService } from '../auth/password.service.js';
import { ApiError } from '../common/api-error.js';

/**
 * Asks for the password again before something that cannot be undone. A wrong password is `401 invalid_credentials`, the
 * same answer as signing in, and counts toward the same lockout (so a stolen session cannot be used to guess the password
 * faster than the sign-in page allows).
 */
@Injectable()
export class ReauthService {
  constructor(
    private readonly db: Database,
    private readonly passwords: PasswordService,
    private readonly throttle: LoginThrottleService,
  ) {}

  async assertPassword(
    userId: string,
    password: string,
    ip: string | null | undefined,
  ): Promise<{ email: string }> {
    const user = await this.db.global.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiError.invalidCredentials();
    await this.throttle.assertNotLocked(user.email, ip);
    const valid = user.disabledAt
      ? await this.passwords.verifyDummy(password)
      : await this.passwords.verify(user.passwordHash, password);
    if (!valid) {
      await this.throttle.recordFailure(user.email, ip);
      throw ApiError.invalidCredentials();
    }
    return { email: user.email };
  }
}
