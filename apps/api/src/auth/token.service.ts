import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Role } from '@orderloop/contracts';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
} from 'jose';
import type { CryptoKey } from 'jose';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { ApiError } from '../common/api-error.js';

export interface AccessClaims {
  userId: string;
  tenantId: string;
  role: Role;
  sessionId: string;
}

const ISSUER = 'orderloop-api';
const AUDIENCE = 'orderloop';
const ALG = 'EdDSA';

@Injectable()
export class TokenService implements OnModuleInit {
  private readonly logger = new Logger(TokenService.name);
  private privateKey!: CryptoKey;
  private publicKey!: CryptoKey;
  private kid!: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    if (this.config.JWT_PRIVATE_KEY && this.config.JWT_PUBLIC_KEY) {
      this.privateKey = await importPKCS8(decodePem(this.config.JWT_PRIVATE_KEY), ALG, {
        extractable: false,
      });
      this.publicKey = await importSPKI(decodePem(this.config.JWT_PUBLIC_KEY), ALG, {
        extractable: true,
      });
    } else {
      // Config validation guarantees this branch is development/test only.
      this.logger.warn(
        'JWT keys not configured: using an ephemeral key; all tokens are invalidated on restart',
      );
      const pair = await generateKeyPair(ALG, { extractable: true });
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
    this.kid = await calculateJwkThumbprint(await exportJWK(this.publicKey));
  }

  get accessTtlSeconds(): number {
    return this.config.ACCESS_TOKEN_TTL_SECONDS;
  }

  signAccessToken(claims: AccessClaims): Promise<string> {
    return (
      new SignJWT({ tid: claims.tenantId, role: claims.role, sid: claims.sessionId })
        .setProtectedHeader({ alg: ALG, kid: this.kid })
        .setSubject(claims.userId)
        // Unique per token: without it, two tokens issued for the same session in the same second are byte-identical.
        .setJti(randomUUID())
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${this.accessTtlSeconds}s`)
        .sign(this.privateKey)
    );
  }

  /** Verifies signature, expiry, issuer and audience. Only the claims needed to look up the session are trusted. */
  async verifyAccessToken(
    token: string,
  ): Promise<{ userId: string; tenantId: string; sessionId: string }> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALG],
      });
      const { sub, tid, sid } = payload as { sub?: string; tid?: unknown; sid?: unknown };
      if (!sub || typeof tid !== 'string' || typeof sid !== 'string')
        throw new Error('missing claims');
      return { userId: sub, tenantId: tid, sessionId: sid };
    } catch (error) {
      const expired = (error as { code?: string }).code === 'ERR_JWT_EXPIRED';
      throw new ApiError(
        expired ? 'token_expired' : 'unauthorized',
        expired ? 'Access token expired' : 'Invalid access token',
      );
    }
  }

  /** 256-bit opaque token (refresh, invitation secret). */
  newOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Only the hash is stored, so a database leak does not yield usable tokens. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

function decodePem(value: string): string {
  return value.includes('BEGIN') ? value : Buffer.from(value, 'base64').toString('utf8');
}
