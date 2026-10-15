/** The kinds of email the API sends. Providers ignore this; tests and logs use it. */
export type MailKind = 'verify_email' | 'password_reset' | 'password_changed' | 'invitation';

export interface MailMessage {
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Delivery channel. Implementations: console (development), SMTP (Mailpit locally, any provider in production),
 * in-memory (tests). To use an HTTP provider such as Resend or SES, add another subclass and select it in MailModule.
 */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}
