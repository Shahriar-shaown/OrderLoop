import type { EmailMessage, EmailSender } from '@orderloop/automation';
import { createTransport, type Transporter } from 'nodemailer';

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
}

/**
 * Sends notification emails through the same SMTP settings the API uses (Mailpit locally, any provider in production), so
 * a notification email looks the same wherever it was made. Not a second mailer design: the API's `Mailer` is a NestJS
 * class the worker cannot import, so this is the same few lines of nodemailer.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(
    private readonly options: SmtpOptions,
    transport?: Transporter,
  ) {
    this.transport =
      transport ??
      createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        ...(options.user && options.password
          ? { auth: { user: options.user, pass: options.password } }
          : {}),
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 10_000,
      });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.options.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      // A stable id: a repeat of the same delivery after a crash carries the same Message-ID.
      messageId: message.messageId,
    });
  }
}

/** `console` mail (development): prints that an email would have been sent, without the address or the body. */
export const consoleEmailSender = (log: (line: string) => void): EmailSender => ({
  async send(message) {
    log(`email (console provider) subject="${message.subject}" id=${message.messageId}`);
  },
});
