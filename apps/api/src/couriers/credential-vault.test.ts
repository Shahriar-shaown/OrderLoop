import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/config.module.js';
import { CredentialVault } from './credential-vault.js';

const key = (seed: string) => Buffer.from(seed.padEnd(32, '0')).toString('base64');
const vault = (over: Partial<AppConfig> = {}) =>
  new CredentialVault({
    COURIER_CREDENTIALS_KEY: key('current'),
    COURIER_CREDENTIALS_KEY_ID: 'k2',
    COURIER_CREDENTIALS_OLD_KEYS: `k1:${key('old')}`,
    ...over,
  } as AppConfig);
const scope = { tenantId: 'tenant-a', provider: 'pathao' };

describe('the courier credential vault', () => {
  it('round-trips a value and never stores it readable', () => {
    const v = vault();
    const sealed = v.encrypt('super-secret-value', scope);
    expect(sealed).not.toContain('super-secret-value');
    expect(sealed.startsWith('v1.k2.')).toBe(true);
    expect(v.decrypt(sealed, scope)).toBe('super-secret-value');
    expect(v.decryptJson<{ a: number }>(v.encryptJson({ a: 1 }, scope), scope)).toEqual({ a: 1 });
  });

  it('seals the same value differently every time', () => {
    const v = vault();
    expect(v.encrypt('same', scope)).not.toBe(v.encrypt('same', scope));
  });

  it('will not open a value moved to another business or another courier', () => {
    const v = vault();
    const sealed = v.encrypt('secret', scope);
    expect(() => v.decrypt(sealed, { ...scope, tenantId: 'tenant-b' })).toThrow(/cannot be read/);
    expect(() => v.decrypt(sealed, { ...scope, provider: 'steadfast' })).toThrow(/cannot be read/);
  });

  it('notices tampering', () => {
    const v = vault();
    const parts = v.encrypt('secret', scope).split('.');
    parts[4] = Buffer.from('forged-ciphertext').toString('base64url');
    expect(() => v.decrypt(parts.join('.'), scope)).toThrow(/cannot be read/);
    expect(() => v.decrypt('v1.k2.x.y', scope)).toThrow(/cannot be read/);
    expect(() => v.decrypt('plaintext', scope)).toThrow(/cannot be read/);
  });

  it('keeps old values readable after the key is rotated, and writes new ones with the new key', () => {
    const before = new CredentialVault({
      COURIER_CREDENTIALS_KEY: key('old'),
      COURIER_CREDENTIALS_KEY_ID: 'k1',
      COURIER_CREDENTIALS_OLD_KEYS: '',
    } as AppConfig);
    const sealed = before.encrypt('secret', scope);
    const after = vault();
    expect(after.decrypt(sealed, scope)).toBe('secret');
    expect(after.encrypt('secret', scope).startsWith('v1.k2.')).toBe(true);
  });

  it('cannot open a value once its key is gone, and refuses to write without a key', () => {
    const sealed = vault().encrypt('secret', scope);
    const lost = vault({
      COURIER_CREDENTIALS_KEY_ID: 'k9',
      COURIER_CREDENTIALS_KEY: key('other'),
      COURIER_CREDENTIALS_OLD_KEYS: '',
    });
    expect(() => lost.decrypt(sealed, scope)).toThrow(/cannot be read/);
    const none = vault({ COURIER_CREDENTIALS_KEY: undefined });
    expect(none.enabled).toBe(false);
    expect(() => none.encrypt('x', scope)).toThrow(/not configured/);
  });
});
