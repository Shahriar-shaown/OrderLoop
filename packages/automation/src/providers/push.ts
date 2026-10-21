import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { DeliveryError, classifyError } from '../classify.js';
import type { Logger } from '../jobs.js';
import type { PushMessage, PushOutcome, PushProvider } from './types.js';

/** A short, stable stand-in for a token in logs and the dev outbox: enough to tell devices apart, useless to anyone else. */
export const tokenFingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 10);

/**
 * The default provider: nothing reaches a phone. It logs one redacted line per message and records it as sent, and (when
 * PUSH_DEV_OUTBOX is set) appends what it would have sent to a file as one JSON object per line, so a developer can watch
 * the pushes arrive with `tail -f`. The token is stored as a fingerprint, never in full.
 */
export class DevPushProvider implements PushProvider {
  readonly name = 'dev' as const;

  constructor(
    private readonly options: {
      log: Logger;
      outboxPath?: string | undefined;
      /** Replaceable in tests. */
      append?: (path: string, line: string) => Promise<void>;
    },
  ) {}

  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    const append = this.options.append ?? ((path, line) => appendFile(path, line, 'utf8'));
    const outcomes: PushOutcome[] = [];
    for (const m of messages) {
      const device = tokenFingerprint(m.token);
      this.options.log({
        event: 'push.dev_sent',
        device,
        platform: m.platform,
        kind: m.data.kind,
      });
      if (this.options.outboxPath) {
        await append(
          this.options.outboxPath,
          `${JSON.stringify({
            at: new Date().toISOString(),
            device,
            platform: m.platform,
            title: m.title,
            body: m.body,
            data: m.data,
          })}\n`,
        );
      }
      outcomes.push({ token: m.token, status: 'ok' });
    }
    return outcomes;
  }
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const EXPO_SEND = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS = 'https://exp.host/--/api/v2/push/getReceipts';
export const EXPO_BATCH = 100;

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Expo's push service (free; it relays to Apple and Google). Sends in batches of 100, treats a per-message error as that
 * device's outcome (`DeviceNotRegistered` means forget the token), and a whole-request failure as transient or permanent by its HTTP
 * status. EXPO_ACCESS_TOKEN is only needed when the Expo project requires authenticated pushes.
 */
export class ExpoPushProvider implements PushProvider {
  readonly name = 'expo' as const;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly options: {
      accessToken?: string | undefined;
      fetch?: FetchLike | undefined;
      timeoutMs?: number | undefined;
      sendUrl?: string | undefined;
      receiptsUrl?: string | undefined;
    } = {},
  ) {
    this.fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async post(url: string, payload: unknown): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(this.options.accessToken
          ? { authorization: `Bearer ${this.options.accessToken}` }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok)
      throw Object.assign(new Error(`Expo push service answered ${res.status}`), {
        status: res.status,
      });
    return res.json();
  }

  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    const outcomes: PushOutcome[] = [];
    for (let i = 0; i < messages.length; i += EXPO_BATCH) {
      const batch = messages.slice(i, i + EXPO_BATCH);
      let body: { data?: ExpoTicket[] };
      try {
        body = (await this.post(
          this.options.sendUrl ?? EXPO_SEND,
          batch.map((m) => ({
            to: m.token,
            title: m.title,
            body: m.body,
            data: m.data,
            sound: 'default',
            priority: 'high',
          })),
        )) as { data?: ExpoTicket[] };
      } catch (error) {
        const c = classifyError(error);
        throw new DeliveryError(
          error instanceof Error ? error.message : 'Expo push failed',
          c.permanent,
          c.reason,
        );
      }
      const tickets = body.data ?? [];
      batch.forEach((m, n) => {
        const t = tickets[n];
        if (t?.status === 'ok') outcomes.push({ token: m.token, status: 'ok', ticketId: t.id });
        else {
          const error = t?.details?.error ?? 'UnknownError';
          outcomes.push({
            token: m.token,
            status: 'error',
            error,
            deviceGone: error === 'DeviceNotRegistered',
            // a full queue or a rate limit passes; everything else about a message is final
            permanent: error !== 'MessageRateExceeded' && error !== 'UnknownError',
          });
        }
      });
    }
    return outcomes;
  }

  async receipts(
    ids: string[],
  ): Promise<Record<string, { ok: boolean; error?: string | undefined }>> {
    const result: Record<string, { ok: boolean; error?: string | undefined }> = {};
    for (let i = 0; i < ids.length; i += 300) {
      const body = (await this.post(this.options.receiptsUrl ?? EXPO_RECEIPTS, {
        ids: ids.slice(i, i + 300),
      })) as { data?: Record<string, { status: string; details?: { error?: string } }> };
      for (const [id, r] of Object.entries(body.data ?? {}))
        result[id] = { ok: r.status === 'ok', error: r.details?.error };
    }
    return result;
  }
}
