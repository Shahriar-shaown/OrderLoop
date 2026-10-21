import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretBoxConfig {
  /** The name of the key in use, stored beside each value so keys can be rotated. */
  keyId: string;
  /** 32 bytes, base64. Without it nothing can be sealed (but old values can still be opened with `oldKeys`). */
  key?: string | undefined;
  /** Retired keys still needed to read old values: `id:base64,id:base64`. */
  oldKeys?: string | undefined;
  /** What to call the key in error messages (the environment variable). */
  keyName?: string;
}

/**
 * Secrets are encrypted before they reach the database and are only ever decrypted in memory, to call the other service.
 * Used for courier credentials and for Meta access tokens, by the API and the worker alike.
 *
 * AES-256-GCM with a fresh 12-byte nonce per value. The tenant and provider are bound in as authenticated data, so a ciphertext
 * copied from one business's row to another's (or from one provider to another) fails to decrypt instead of leaking. The
 * stored form is `v1.<keyId>.<nonce>.<tag>.<ciphertext>` (base64url).
 */
export class SecretBox {
  private readonly keys = new Map<string, Buffer>();
  private readonly currentId: string;
  private readonly keyName: string;

  constructor(config: SecretBoxConfig) {
    this.currentId = config.keyId;
    this.keyName = config.keyName ?? 'The credentials key';
    if (config.key) this.keys.set(this.currentId, Buffer.from(config.key, 'base64'));
    for (const entry of (config.oldKeys ?? '').split(',').filter(Boolean)) {
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
    if (!key) throw new Error(`${this.keyName} is not configured`);
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
      throw new Error('The saved secret cannot be read with the configured keys');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(`${scope.tenantId}:${scope.provider}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('The saved secret cannot be read with the configured keys');
    }
  }

  encryptJson(value: unknown, scope: { tenantId: string; provider: string }): string {
    return this.encrypt(JSON.stringify(value), scope);
  }

  decryptJson<T>(stored: string, scope: { tenantId: string; provider: string }): T {
    return JSON.parse(this.decrypt(stored, scope)) as T;
  }
}
