import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { REDIS } from '../redis/redis.module.js';

/** Failures from one IP against one account before that IP is locked out of that account. */
export const PER_IP_MAX = 5;
/** Failures across all IPs against one account before the account is locked for everyone (distributed guessing). */
export const ACCOUNT_MAX = 50;
const WINDOW_SECONDS = 15 * 60;

/** The slice of Redis this service needs; small enough to fake in unit tests. */
export interface ThrottleStore {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
  del(...keys: string[]): Promise<unknown>;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Brute-force protection on top of the per-IP request rate limit.
 *
 * Two counters, so that locking cannot be used as a cheap way to lock a victim out: five bad passwords lock
 * only the (account, IP) pair that made them; a much higher account-wide threshold catches guessing spread
 * across many IPs. Fails open if Redis is down (the request rate limit still applies).
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);

  constructor(
    @Inject(REDIS) private readonly redis: ThrottleStore,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'RATE_LIMIT_ENABLED'>,
  ) {}

  private keys(email: string, ip: string | null | undefined) {
    const account = digest(email);
    return {
      pair: `login-fail:pair:${account}:${digest(ip ?? 'unknown')}`,
      account: `login-fail:acct:${account}`,
    };
  }

  async assertNotLocked(email: string, ip: string | null | undefined): Promise<void> {
    const { pair, account } = this.keys(email, ip);
    try {
      for (const [key, max] of [
        [pair, PER_IP_MAX],
        [account, ACCOUNT_MAX],
      ] as const) {
        if (Number((await this.redis.get(key)) ?? 0) >= max) {
          const ttl = await this.redis.ttl(key);
          throw new ApiError(
            'rate_limited',
            `Too many failed attempts. Try again in ${Math.max(1, Math.ceil(ttl / 60))} minute(s).`,
          );
        }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.logger.warn('login lockout check skipped: redis unavailable');
    }
  }

  async recordFailure(email: string, ip: string | null | undefined): Promise<void> {
    const { pair, account } = this.keys(email, ip);
    try {
      for (const key of [pair, account]) {
        if ((await this.redis.incr(key)) === 1) await this.redis.expire(key, WINDOW_SECONDS);
      }
    } catch {
      this.logger.warn('login failure not recorded: redis unavailable');
    }
  }

  /**
   * At most 3 emails of one kind per address per hour, so an endpoint cannot be used to flood someone's inbox. Each kind has
   * its own count, so spam of one cannot use up the other. Fails open.
   */
  allowResetRequest(
    email: string,
    kind: 'reset-req' | 'exists-notice' = 'reset-req',
  ): Promise<boolean> {
    return this.hit(`${kind}:${digest(email)}`, 3, 3600);
  }

  /** Count one use; false once more than `max` uses fall inside the window. Fails open. */
  private async hit(key: string, max: number, windowSeconds: number): Promise<boolean> {
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, windowSeconds);
      return count <= max;
    } catch {
      return true;
    }
  }

  /**
   * A budget for one subject (a tenant, a user) on top of the per-IP request limit: at most `max` uses of `scope` per
   * window, else 429. Off together with the request limit (RATE_LIMIT_ENABLED), and fails open if Redis is down.
   */
  async enforce(scope: string, subject: string, max: number, windowSeconds: number): Promise<void> {
    if (!this.config.RATE_LIMIT_ENABLED) return;
    if (!(await this.hit(`limit:${scope}:${digest(subject)}`, max, windowSeconds)))
      throw new ApiError('rate_limited', 'Too many requests, slow down');
  }

  async clear(email: string, ip: string | null | undefined): Promise<void> {
    const { pair, account } = this.keys(email, ip);
    try {
      await this.redis.del(pair, account);
    } catch {
      /* best effort */
    }
  }
}
