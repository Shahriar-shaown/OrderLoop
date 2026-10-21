import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ingestEvents,
  parseWebhook,
  safeEqual,
  verifyHubSignature,
  type JobQueue,
} from '@orderloop/automation';
import { Database } from '@orderloop/db';
import { ApiError } from '../common/api-error.js';
import { META_EVENTS_QUEUE } from '../queue/queue.module.js';
import { MetaRuntime } from './meta.runtime.js';

/**
 * Meta's webhook. It arrives from the open internet with no session, so the ORDER of the steps is the defence:
 * (1) check X-Hub-Signature-256 over the raw bytes, in constant time; (2) only then parse; (3) store each event (the unique key
 * makes Meta's retries harmless) and queue it; (4) answer 200 at once. Everything slow (extraction) happens in the worker.
 */
@Injectable()
export class MetaWebhookService {
  private readonly log = new Logger('MetaWebhook');

  constructor(
    private readonly db: Database,
    private readonly runtime: MetaRuntime,
    @Inject(META_EVENTS_QUEUE) private readonly queue: JobQueue,
  ) {}

  /** The subscription handshake: answers the challenge only when the verify token is the one we configured. */
  verify(query: Record<string, string | undefined>): string {
    const expected = this.runtime.config.META_WEBHOOK_VERIFY_TOKEN;
    const given = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (
      query['hub.mode'] !== 'subscribe' ||
      !expected ||
      given === undefined ||
      challenge === undefined
    )
      throw ApiError.forbidden('Verification failed');
    if (!safeEqual(given, expected)) throw ApiError.forbidden('Verification failed');
    return challenge;
  }

  async receive(
    raw: unknown,
    signature: string | string[] | undefined,
  ): Promise<{ status: string }> {
    const secret = this.runtime.appSecret;
    if (!secret) throw ApiError.notFound(); // no Meta app configured: there is no such endpoint
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.alloc(0);
    if (!verifyHubSignature(bytes, signature, secret)) {
      this.log.warn('Rejected a Meta webhook: missing or invalid signature');
      throw ApiError.unauthorized('Invalid signature');
    }
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ApiError('validation_failed', 'The body is not JSON');
    }
    const parsed = parseWebhook(body);
    if (!parsed.object) return { status: 'ignored' }; // validly signed, but not a Page or Instagram notification
    const { summary } = await ingestEvents(
      {
        db: this.db,
        queue: this.queue,
        log: (e) => this.log.warn(`${e.event}: ${e.outcome ?? ''}`),
      },
      parsed.events,
    );
    this.log.log(
      `Meta webhook: ${summary.stored} stored, ${summary.duplicates} repeats, ${summary.unknownAccount} for unknown accounts, ${parsed.skipped} not kept`,
    );
    return { status: 'ok' };
  }
}
