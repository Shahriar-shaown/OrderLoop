import 'reflect-metadata';
import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { describe, expect, it } from 'vitest';
import { TokenService } from './token.service.js';
import type { AppConfig } from '../config/config.module.js';

const config = { ACCESS_TOKEN_TTL_SECONDS: 900 } as AppConfig;
const claims = {
  userId: '0197b0a0-0000-7000-8000-000000000001',
  tenantId: '0197b0a0-0000-7000-8000-000000000002',
  role: 'OWNER' as const,
  sessionId: '0197b0a0-0000-7000-8000-000000000003',
};

async function service(ttl = 900) {
  const s = new TokenService({ ...config, ACCESS_TOKEN_TTL_SECONDS: ttl });
  await s.onModuleInit();
  return s;
}

describe('TokenService', () => {
  it('round-trips access-token claims', async () => {
    const s = await service();
    const token = await s.signAccessToken(claims);
    expect(await s.verifyAccessToken(token)).toEqual({
      userId: claims.userId,
      tenantId: claims.tenantId,
      sessionId: claims.sessionId,
    });
  });

  it('issues a distinct token every time, even for the same session in the same second', async () => {
    const s = await service();
    const [a, b] = await Promise.all([s.signAccessToken(claims), s.signAccessToken(claims)]);
    expect(a).not.toBe(b);
    // ...and both still verify to the same identity.
    expect(await s.verifyAccessToken(a)).toEqual(await s.verifyAccessToken(b));
  });

  it('rejects a tampered token', async () => {
    const s = await service();
    const token = await s.signAccessToken(claims);
    const [h, p, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(p!, 'base64url').toString()),
        tid: '0197b0a0-0000-7000-8000-0000000000ff',
      }),
    ).toString('base64url');
    await expect(s.verifyAccessToken(`${h}.${forged}.${sig}`)).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
  });

  it('rejects a token signed by a different key', async () => {
    const s = await service();
    const other = await generateKeyPair('EdDSA');
    const token = await new SignJWT({ tid: claims.tenantId, sid: claims.sessionId })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(claims.userId)
      .setIssuer('orderloop-api')
      .setAudience('orderloop')
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(s.verifyAccessToken(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects the none algorithm', async () => {
    const s = await service();
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: claims.userId, tid: claims.tenantId, sid: claims.sessionId })).toString('base64url')}.`;
    await expect(s.verifyAccessToken(unsigned)).rejects.toMatchObject({ status: 401 });
  });

  it('reports expiry distinctly', async () => {
    const s = new TokenService({ ...config, ACCESS_TOKEN_TTL_SECONDS: 60 });
    await s.onModuleInit();
    const expired = await new SignJWT({ tid: claims.tenantId, sid: claims.sessionId })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(claims.userId)
      .setIssuer('orderloop-api')
      .setAudience('orderloop')
      .setIssuedAt(1)
      .setExpirationTime(2)
      .sign((s as unknown as { privateKey: CryptoKey }).privateKey);
    await expect(s.verifyAccessToken(expired)).rejects.toMatchObject({ code: 'token_expired' });
  });

  it('hashes opaque tokens deterministically and never stores them raw', async () => {
    const s = await service();
    const t = s.newOpaqueToken();
    expect(t.length).toBeGreaterThanOrEqual(43);
    expect(s.hashToken(t)).toBe(s.hashToken(t));
    expect(s.hashToken(t)).not.toContain(t);
    expect(s.newOpaqueToken()).not.toBe(t);
  });
});
