import type { MessagingChannel, PushProviderName } from '@orderloop/contracts';
import type { Logger } from '../jobs.js';

export interface PushMessage {
  token: string;
  platform: 'ios' | 'android';
  title: string;
  body: string;
  /** Only `{kind, id}`: the app fetches the notification after the person signs in. */
  data: { kind: string; id: string };
}

export type PushOutcome =
  | { token: string; status: 'ok'; ticketId?: string | undefined }
  | {
      token: string;
      status: 'error';
      /** The provider's own code, e.g. `DeviceNotRegistered`. */
      error: string;
      /** The device is gone: forget its token. */
      deviceGone: boolean;
      /** Trying again cannot help (as opposed to a rate limit or an outage). */
      permanent: boolean;
    };

export interface PushProvider {
  readonly name: PushProviderName;
  send(messages: PushMessage[]): Promise<PushOutcome[]>;
  /** Later verdicts on tickets (Expo reports dead devices in receipts, minutes after sending). Optional. */
  receipts?(ids: string[]): Promise<Record<string, { ok: boolean; error?: string | undefined }>>;
}

export interface MessagingMessage {
  channel: MessagingChannel;
  /** E.164 number. */
  to: string;
  body: string;
  /** Stable per delivery: a provider that supports idempotency uses it so a retry after a crash cannot send twice. */
  idempotencyKey: string;
}
export interface MessagingProvider {
  readonly name: string;
  send(message: MessagingMessage): Promise<{ providerRef?: string | undefined }>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable per delivery (`<delivery-id@orderloop>`): mail systems that de-duplicate on Message-ID drop a re-send. */
  messageId: string;
}
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** What the delivery processor can send with. A missing entry means that channel is not available on this server. */
export interface DeliveryProviders {
  push: Partial<Record<PushProviderName, PushProvider>>;
  email: EmailSender | null;
  sms: MessagingProvider | null;
  whatsapp: MessagingProvider | null;
}

export type { Logger };
