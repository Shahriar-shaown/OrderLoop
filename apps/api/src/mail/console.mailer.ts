import { Injectable } from '@nestjs/common';
import { Mailer, type MailMessage } from './mailer.js';

/**
 * Development only: prints the email, including its one-time link, straight to the terminal instead of sending it.
 * It deliberately does NOT go through the structured logger, whose redaction would (correctly) mask the very link
 * a developer needs. Environment validation refuses MAIL_PROVIDER=console when NODE_ENV=production.
 */
@Injectable()
export class ConsoleMailer extends Mailer {
  async send(message: MailMessage): Promise<void> {
    process.stdout.write(
      `\n[dev email] to=${message.to} kind=${message.kind} subject="${message.subject}"\n${message.text}\n\n`,
    );
  }
}
