import type { Logger } from '../jobs.js';
import type { MessagingMessage, MessagingProvider } from './types.js';

/** `+8801712345678` -> `+88017*******78`: enough to recognise in a log, not enough to call. */
export const maskPhone = (phone: string): string =>
  phone.length <= 6
    ? '***'
    : `${phone.slice(0, 6)}${'*'.repeat(phone.length - 8)}${phone.slice(-2)}`;

/**
 * The only SMS and WhatsApp "provider" there is: it logs a redacted line (channel, masked number, message length) and records
 * the message as delivered. No real vendor is integrated; a vendor adapter implements {@link MessagingProvider} and is chosen
 * in the worker's wiring.
 */
export class ConsoleMessagingProvider implements MessagingProvider {
  readonly name = 'console';
  constructor(
    private readonly options: {
      log: Logger;
      /** Test hook: see what would have been sent. */
      sink?: ((message: MessagingMessage) => void) | undefined;
    },
  ) {}

  async send(message: MessagingMessage): Promise<{ providerRef: string }> {
    this.options.sink?.(message);
    this.options.log({
      event: 'messaging.console_sent',
      channel: message.channel,
      to: maskPhone(message.to),
      length: message.body.length,
      idempotencyKey: message.idempotencyKey,
    });
    return { providerRef: `console:${message.idempotencyKey}` };
  }
}
