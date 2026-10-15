import { Injectable } from '@nestjs/common';
import { TokenPurpose, type Tx } from '@orderloop/db';
import { TokenService } from './token.service.js';

export const EMAIL_VERIFICATION_TTL_MS = 24 * 3_600_000;
export const PASSWORD_RESET_TTL_MS = 3_600_000;

/** One-time emailed tokens (verification, password reset): random, hashed at rest, single use, short-lived. */
@Injectable()
export class UserTokenService {
  constructor(private readonly tokens: TokenService) {}

  /**
   * Issue a token inside the caller's transaction and return the raw value (to be emailed after commit).
   * By default any earlier unused token for the same purpose is expired, so only the newest link works. Pass
   * `supersede: false` where an outsider can trigger issuance (password reset), so they cannot kill your link.
   */
  async issue(
    tx: Tx,
    userId: string,
    purpose: TokenPurpose,
    ttlMs: number,
    options: { supersede?: boolean } = {},
  ): Promise<string> {
    const now = new Date();
    if (options.supersede !== false) {
      await tx.userToken.updateMany({
        where: { userId, purpose, usedAt: null, expiresAt: { gt: now } },
        data: { expiresAt: now },
      });
    }
    const raw = this.tokens.newOpaqueToken();
    await tx.userToken.create({
      data: {
        userId,
        purpose,
        tokenHash: this.tokens.hashToken(raw),
        expiresAt: new Date(now.getTime() + ttlMs),
      },
    });
    return raw;
  }

  /** Read-only check, so junk tokens are rejected before any expensive work (such as password hashing). */
  async peek(
    tx: Pick<Tx, 'userToken'>,
    raw: string,
    purpose: TokenPurpose,
  ): Promise<string | null> {
    const row = await tx.userToken.findUnique({ where: { tokenHash: this.tokens.hashToken(raw) } });
    return row && row.purpose === purpose && !row.usedAt && row.expiresAt > new Date()
      ? row.userId
      : null;
  }

  /**
   * Atomically spend a token. Of two concurrent attempts only one can flip `usedAt` from null, so a link
   * works exactly once. Returns the owning user id, or null when the token is unknown, wrong-purpose, used or expired.
   */
  async consume(tx: Tx, raw: string, purpose: TokenPurpose): Promise<string | null> {
    const tokenHash = this.tokens.hashToken(raw);
    const row = await tx.userToken.findUnique({ where: { tokenHash } });
    if (!row || row.purpose !== purpose) return null;
    const claimed = await tx.userToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    return claimed.count === 1 ? row.userId : null;
  }
}
