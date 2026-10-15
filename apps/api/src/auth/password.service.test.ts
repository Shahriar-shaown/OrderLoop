import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const svc = new PasswordService();
  it('hashes with argon2id and verifies', async () => {
    const h = await svc.hash('correct horse battery');
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await svc.verify(h, 'correct horse battery')).toBe(true);
    expect(await svc.verify(h, 'wrong password!!')).toBe(false);
  });
  it('salts: same password hashes differently', async () => {
    expect(await svc.hash('same-password-1')).not.toBe(await svc.hash('same-password-1'));
  });
  it('treats a malformed stored hash as a failed verification', async () => {
    expect(await svc.verify('not-a-hash', 'x')).toBe(false);
  });
  it('dummy verification returns false', async () => {
    expect(await svc.verifyDummy('anything')).toBe(false);
  });
});
