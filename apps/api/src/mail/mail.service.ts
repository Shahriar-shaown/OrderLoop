import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { scrubSecrets } from '../logging/scrub.js';
import { Mailer, type MailMessage } from './mailer.js';

/** Sends email without ever failing the request that triggered it: a mail outage must not break sign-up or invitations. */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly mailer: Mailer) {}

  /** Resolves to whether the message was handed to the provider. Never throws. */
  async send(message: MailMessage): Promise<boolean> {
    try {
      await this.mailer.send(message);
      return true;
    } catch (error) {
      // Log who and what failed, never the body (it holds a live token) and never the plain address.
      this.logger.error(
        `email send failed kind=${message.kind} toHash=${createHash('sha256').update(message.to).digest('hex').slice(0, 12)} reason=${scrubSecrets(error instanceof Error ? error.message : 'unknown')}`,
      );
      return false;
    }
  }
}
