import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ingestTikTokEvent,
  parseTikTokWebhook,
  verifyTikTokWebhook,
  type JobQueue,
  type TikTokMetrics,
} from '@orderloop/automation';
import { Database } from '@orderloop/db';
import { ApiError } from '../common/api-error.js';
import { TIKTOK_EVENTS_QUEUE } from '../queue/queue.module.js';
import { TIKTOK_METRICS, toLogFn } from './tiktok.providers.js';
import { TikTokRuntime } from './tiktok.runtime.js';

/**
 * TikTok Shop's webhook. It arrives from the open internet with no session, so the ORDER of the steps is the defence:
 * (1) check the Authorization header (HMAC-SHA256 of app_key + the raw bytes) in constant time; (2) only then parse; (3) store the
 * event (the unique key makes TikTok's retries harmless) and queue it; (4) answer 200 with an EMPTY body at once, inside TikTok's
 * three seconds even when Redis is down (the stored event is queued later by the sweeper). Everything slow happens in the worker.
 */
@Injectable()
export class TikTokWebhookService {
  private readonly log = new Logger('TikTokWebhook');

  constructor(
    private readonly db: Database,
    private readonly runtime: TikTokRuntime,
    @Inject(TIKTOK_EVENTS_QUEUE) private readonly queue: JobQueue,
    @Inject(TIKTOK_METRICS) private readonly metrics: TikTokMetrics,
  ) {}

  async receive(raw: unknown, authorization: string | string[] | undefined): Promise<void> {
    const key = this.runtime.appKey;
    const secret = this.runtime.appSecret;
    if (!key || !secret) throw ApiError.notFound(); // no TikTok app configured: there is no such endpoint
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.alloc(0);
    if (!verifyTikTokWebhook(bytes, authorization, key, secret)) {
      this.metrics.event('bad_signature');
      this.log.warn('Rejected a TikTok webhook: missing or invalid signature');
      throw ApiError.unauthorized('Invalid signature');
    }
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString('utf8'));
    } catch {
      // Validly signed but not JSON: nothing to keep, and a non-200 would only make TikTok retry the same bytes.
      this.log.warn('A signed TikTok webhook was not JSON');
      return;
    }
    const event = parseTikTokWebhook(body);
    if (!event) return; // signed, but not a notification we can attach to a shop
    const { summary } = await ingestTikTokEvent(
      { db: this.db, queue: this.queue, log: toLogFn(this.log), metrics: this.metrics },
      event,
    );
    this.log.log(
      `TikTok webhook: ${summary.stored} stored, ${summary.duplicates} repeats, ${summary.unknownShop} for unknown shops, ${summary.ignored} ignored`,
    );
  }
}
