import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';

/**
 * Courier secrets are encrypted before they reach the database and are only ever decrypted in memory, to call the courier.
 *
 * AES-256-GCM with a fresh 12-byte nonce per value. The tenant and provider are bound in as authenticated data, so a
 * ciphertext copied from one business's row to another's (or from one courier to another) fails to decrypt instead of
 * leaking. The stored form is `v1.<keyId>.<nonce>.<tag>.<ciphertext>` (base64url), so keys can be rotated: new values use
 * the current key, old values are read with the key their id names.
 */
@Injectable()
export class CredentialVault {
  private readonly keys = new Map<string, Buffer>();
  private readonly currentId: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.currentId = config.COURIER_CREDENTIALS_KEY_ID;
    if (config.COURIER_CREDENTIALS_KEY)
      this.keys.set(this.currentId, Buffer.from(config.COURIER_CREDENTIALS_KEY, 'base64'));
    for (const entry of config.COURIER_CREDENTIALS_OLD_KEYS.split(',').filter(Boolean)) {
      const [id, key] = entry.split(':') as [string, string];
      this.keys.set(id, Buffer.from(key, 'base64'));
    }
  }

  /** Whether secrets can be stored at all (a key is configured). */
  get enabled(): boolean {
    return this.keys.has(this.currentId);
  }

  encrypt(plaintext: string, scope: { tenantId: string; provider: string }): string {
    const key = this.keys.get(this.currentId);
    if (!key) throw new Error('COURIER_CREDENTIALS_KEY is not configured');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`${scope.tenantId}:${scope.provider}`));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      this.currentId,
      ...[nonce, cipher.getAuthTag(), body].map((b) => b.toString('base64url')),
    ].join('.');
  }

  /** Throws when the value was tampered with, belongs to another business, or its key is gone. */
  decrypt(stored: string, scope: { tenantId: string; provider: string }): string {
    const [version, keyId, nonce, tag, body] = stored.split('.');
    const key = keyId ? this.keys.get(keyId) : undefined;
    if (version !== 'v1' || !key || !nonce || !tag || !body)
      throw new Error('The saved courier secret cannot be read with the configured keys');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(`${scope.tenantId}:${scope.provider}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('The saved courier secret cannot be read with the configured keys');
    }
  }

  encryptJson(value: unknown, scope: { tenantId: string; provider: string }): string {
    return this.encrypt(JSON.stringify(value), scope);
  }

  decryptJson<T>(stored: string, scope: { tenantId: string; provider: string }): T {
    return JSON.parse(this.decrypt(stored, scope)) as T;
  }
}
