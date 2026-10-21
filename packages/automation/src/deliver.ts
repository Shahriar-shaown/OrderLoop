import { type NotificationChannel } from '@orderloop/contracts';
import { Database } from '@orderloop/db';
import { pushPayload } from '@orderloop/domain';
import { DeliveryError, classifyError, scrubError } from './classify.js';
import {
  AUTOMATION_JOB_OPTIONS,
  RECEIPTS_DELAY_MS,
  jobIdOf,
  type JobQueue,
  type Logger,
} from './jobs.js';
import type { DeliveryProviders } from './providers/index.js';

export interface DeliverDeps {
  db: Database;
  providers: DeliveryProviders;
  now: () => Date;
  log: Logger;
  /** Where to ask for Expo's receipts later. Optional: without it dead devices are only found from tickets. */
  receiptsQueue?: JobQueue | undefined;
}

export interface DeliverInfo {
  jobId?: string | undefined;
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
}

export type DeliverOutcome =
  /** Nothing to do: already sent or skipped, or another worker holds it. */
  | { outcome: 'noop' }
  | { outcome: 'sent' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; reason: string };

/** A worker holds a delivery for at most this long before another may take it (a crashed worker's lease). */
export const LEASE_MS = 5 * 60_000;

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The same wording as the in-app notification (it carries no customer data), plus where to look. */
export function emailContent(n: { title: string; body: string }): {
  subject: string;
  text: string;
  html: string;
} {
  return {
    subject: n.title,
    text: `${n.body}\n\nOpen OrderLoop to see the details.\n`,
    html: `<p>${escapeHtml(n.body)}</p><p>Open OrderLoop to see the details.</p>`,
  };
}

class Skip extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Send one delivery. The claim is `UPDATE ... WHERE status IN ('pending','failed')` (with a lease), so a delivery that was
 * sent, skipped or is held by another worker is never sent again, whatever is queued. `reclaim` (the queue is redelivering, so
 * the previous attempt is over) ignores the lease.
 *
 * Not every failure is retried: a permanent one (a refused address, a provider rejecting the request) is recorded as `failed`
 * and the job ends; a missing device or consent is `skipped`; a transient one is recorded as `failed` and thrown so the queue
 * retries it with back-off.
 *
 * The unavoidable edge: a crash after the provider accepted the message and before it is marked `sent` makes the retry send it
 * again (at-least-once). Email carries a stable Message-ID and messaging providers get a stable idempotency key, which
 * lets a provider that supports it drop the repeat; push has no such key.
 */
export async function processDelivery(
  deps: DeliverDeps,
  job: { tenantId: string; deliveryId: string },
  info: DeliverInfo = {},
): Promise<DeliverOutcome> {
  const started = Date.now();
  const ctx = { tenantId: job.tenantId };
  const now = deps.now();
  const reclaim = (info.attempt ?? 1) > 1;
  const leaseCutoff = new Date(now.getTime() - LEASE_MS);

  const claimed = await deps.db.withContext(
    ctx,
    (tx) =>
      tx.$queryRaw<
        { id: string; notification_id: string; channel: NotificationChannel; attempts: number }[]
      >`
      UPDATE notification_deliveries
      SET claimed_at = ${now}::timestamptz, attempts = attempts + 1, updated_at = ${now}::timestamptz
      WHERE id = ${job.deliveryId}::uuid AND tenant_id = ${job.tenantId}::uuid
        AND status IN ('pending', 'failed') AND channel <> 'in_app'
        AND (${reclaim}::boolean OR claimed_at IS NULL OR claimed_at < ${leaseCutoff}::timestamptz)
      RETURNING id, notification_id, channel, attempts`,
  );
  const delivery = claimed[0];
  const base = {
    event: 'automation.delivery',
    tenantId: job.tenantId,
    deliveryId: job.deliveryId,
    jobId: info.jobId,
    attempt: info.attempt,
  };
  if (!delivery) {
    deps.log({ ...base, outcome: 'noop', durationMs: Date.now() - started });
    return { outcome: 'noop' };
  }
  const channel = delivery.channel;

  const finish = async (
    status: 'sent' | 'failed' | 'skipped',
    lastError: string | null,
  ): Promise<void> => {
    await deps.db.withContext(ctx, (tx) =>
      tx.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status,
          lastError,
          claimedAt: null,
          sentAt: status === 'sent' ? deps.now() : null,
          updatedAt: deps.now(),
        },
      }),
    );
  };

  try {
    await send(deps, job.tenantId, delivery.id, delivery.notification_id, channel);
    await finish('sent', null);
    deps.log({ ...base, channel, outcome: 'sent', durationMs: Date.now() - started });
    return { outcome: 'sent' };
  } catch (error) {
    if (error instanceof Skip) {
      await finish('skipped', error.reason);
      deps.log({
        ...base,
        channel,
        outcome: 'skipped',
        reason: error.reason,
        durationMs: Date.now() - started,
      });
      return { outcome: 'skipped', reason: error.reason };
    }
    const c = classifyError(error);
    const message =
      `${c.permanent ? 'permanent' : 'transient'}:${c.reason}: ${scrubError(error)}`.slice(0, 300);
    await finish('failed', message);
    deps.log({
      ...base,
      level: c.permanent ? 'warn' : 'error',
      channel,
      outcome: c.permanent ? 'failed_permanent' : 'failed_transient',
      reason: c.reason,
      willRetry:
        !c.permanent && (info.attempt ?? 1) < (info.maxAttempts ?? AUTOMATION_JOB_OPTIONS.attempts),
      durationMs: Date.now() - started,
    });
    if (c.permanent) return { outcome: 'failed', reason: c.reason };
    throw error; // transient: let the queue retry
  }
}

async function send(
  deps: DeliverDeps,
  tenantId: string,
  deliveryId: string,
  notificationId: string,
  channel: NotificationChannel,
): Promise<void> {
  const ctx = { tenantId };
  const loaded = await deps.db.withContext(ctx, async (tx) => {
    const notification = await tx.notification.findFirst({
      where: { id: notificationId, tenantId },
    });
    if (!notification) return null;
    const member = await tx.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId: notification.userId } },
      select: { user: { select: { email: true, disabledAt: true } } },
    });
    const devices =
      channel === 'push'
        ? await tx.pushDevice.findMany({
            where: { userId: notification.userId },
            select: { token: true, platform: true, provider: true },
          })
        : [];
    const consent =
      channel === 'sms' || channel === 'whatsapp'
        ? await tx.messagingConsent.findUnique({
            where: { tenantId_userId_channel: { tenantId, userId: notification.userId, channel } },
          })
        : null;
    return { notification, member, devices, consent };
  });
  if (!loaded?.member) throw new Skip('recipient_gone');
  const { notification, member, devices, consent } = loaded;
  if (member.user.disabledAt) throw new Skip('recipient_disabled');

  if (channel === 'email') {
    if (!deps.providers.email) throw new Skip('channel_not_configured');
    const content = emailContent(notification);
    await deps.providers.email.send({
      to: member.user.email,
      ...content,
      messageId: `<${deliveryId}@orderloop.local>`,
    });
    return;
  }

  if (channel === 'sms' || channel === 'whatsapp') {
    const provider = deps.providers[channel];
    if (!provider) throw new Skip('channel_not_configured');
    if (!consent || consent.revokedAt) throw new Skip('no_consent');
    if (!consent.phone) throw new Skip('no_phone');
    await provider.send({
      channel,
      to: consent.phone,
      body: `${notification.title}: ${notification.body}`,
      idempotencyKey: deliveryId,
    });
    return;
  }

  if (channel === 'push') {
    if (devices.length === 0) throw new Skip('no_device');
    const payload = pushPayload(notification.kind, notification.id);
    let ok = 0;
    let transient = 0;
    let gone = 0;
    let rejected = 0;
    let mismatched = 0;
    const tickets: { id: string; token: string }[] = [];
    for (const providerName of ['expo', 'dev'] as const) {
      const group = devices.filter((d) => d.provider === providerName);
      if (group.length === 0) continue;
      const provider = deps.providers.push[providerName];
      if (!provider) {
        mismatched += group.length;
        continue;
      }
      const outcomes = await provider.send(
        group.map((d) => ({ token: d.token, platform: d.platform, ...payload })),
      );
      for (const o of outcomes) {
        if (o.status === 'ok') {
          ok += 1;
          if (o.ticketId) tickets.push({ id: o.ticketId, token: o.token });
        } else if (o.deviceGone) {
          gone += 1;
          await deps.db.removePushToken(o.token);
        } else if (o.permanent) rejected += 1;
        else transient += 1;
      }
    }
    if (tickets.length && deps.receiptsQueue)
      await deps.receiptsQueue.add(
        'receipts',
        { tickets },
        {
          jobId: jobIdOf('receipts', deliveryId),
          delay: RECEIPTS_DELAY_MS,
          ...AUTOMATION_JOB_OPTIONS,
        },
      );
    if (ok > 0) return;
    if (transient > 0)
      throw new DeliveryError('push provider is busy', false, 'provider_unavailable');
    if (rejected > 0)
      throw new DeliveryError('push provider rejected the message', true, 'rejected');
    if (gone > 0) throw new Skip('device_not_registered');
    if (mismatched > 0) throw new Skip('provider_mismatch');
    throw new Skip('no_device');
  }
}

/** Expo reports dead devices in receipts, some minutes after the send: forget those tokens. */
export async function processReceipts(
  deps: Pick<DeliverDeps, 'db' | 'providers' | 'log'>,
  job: { tickets: { id: string; token: string }[] },
): Promise<{ removed: number }> {
  const provider = deps.providers.push.expo;
  if (!provider?.receipts) return { removed: 0 };
  const receipts = await provider.receipts(job.tickets.map((t) => t.id));
  let removed = 0;
  for (const t of job.tickets) {
    const r = receipts[t.id];
    if (r && !r.ok && r.error === 'DeviceNotRegistered')
      removed += await deps.db.removePushToken(t.token);
  }
  deps.log({ event: 'push.receipts', tickets: job.tickets.length, removed });
  return { removed };
}
