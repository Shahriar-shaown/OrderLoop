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
  /** Refuse to send (and to send credentials) unless the connection is upgraded with STARTTLS. Set in production when `secure` is false. */
  requireTls?: boolean;
}

/** The nodemailer settings for these options. */
export function smtpTransportOptions(options: SmtpOptions) {
  return {
    host: options.host,
    port: options.port,
    secure: options.secure,
    // Without this, a server that does not offer STARTTLS (or a downgrade by someone on the path) leaves the login and the
    // message, which carries password-reset links, in clear text.
    ...(options.requireTls && !options.secure ? { requireTLS: true } : {}),
    ...(options.user && options.password
      ? { auth: { user: options.user, pass: options.password } }
      : {}),
    // Fail fast: an unreachable mail server must not hold an API request open.
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10_000,
  };
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
    this.transport = transport ?? createTransport(smtpTransportOptions(options));
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
