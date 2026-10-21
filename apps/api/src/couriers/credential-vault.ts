import { Inject, Injectable } from '@nestjs/common';
import { SecretBox } from '@orderloop/automation';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';

/**
 * Courier credentials and Meta access tokens are encrypted before they reach the database and are only decrypted in memory
 * (see SecretBox for the format and what is bound in). One key for both: COURIER_CREDENTIALS_KEY, rotated with its id and
 * COURIER_CREDENTIALS_OLD_KEYS.
 */
@Injectable()
export class CredentialVault extends SecretBox {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      keyId: config.COURIER_CREDENTIALS_KEY_ID,
      key: config.COURIER_CREDENTIALS_KEY,
      oldKeys: config.COURIER_CREDENTIALS_OLD_KEYS,
      keyName: 'COURIER_CREDENTIALS_KEY',
    });
  }
}
