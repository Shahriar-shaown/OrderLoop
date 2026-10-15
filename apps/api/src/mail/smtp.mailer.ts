import { Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { Mailer, type MailMessage } from './mailer.js';

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
}

/** Sends through any SMTP server: Mailpit in development, Postmark, SES, SendGrid, Mailgun or Resend (via SMTP) in production. */
@Injectable()
export class SmtpMailer extends Mailer {
  private readonly transport: Transporter;

  constructor(
    private readonly options: SmtpOptions,
    transport?: Transporter,
  ) {
    super();
    this.transport =
      transport ??
      createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        ...(options.user && options.password
          ? { auth: { user: options.user, pass: options.password } }
          : {}),
        // Fail fast: an unreachable mail server must not hold an API request open.
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 10_000,
      });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.options.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
