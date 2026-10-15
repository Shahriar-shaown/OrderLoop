import { Injectable } from '@nestjs/common';
import { Mailer, type MailKind, type MailMessage } from './mailer.js';

/** Test double: records messages and extracts the one-time token from the link in the body. */
@Injectable()
export class MemoryMailer extends Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  to(email: string, kind?: MailKind): MailMessage[] {
    return this.sent.filter((m) => m.to === email && (!kind || m.kind === kind));
  }

  /** The most recent one-time token emailed to `email` for `kind`. Throws if none, so a missing email fails the test loudly. */
  tokenFor(email: string, kind: MailKind): string {
    const message = this.to(email, kind).at(-1);
    if (!message) throw new Error(`No ${kind} email was sent to ${email}`);
    const match = /[?&]token=([^\s&"<]+)/.exec(message.text);
    if (!match) throw new Error(`No token link in ${kind} email to ${email}`);
    return decodeURIComponent(match[1]!);
  }
}
