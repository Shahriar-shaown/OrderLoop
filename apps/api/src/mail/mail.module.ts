import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { ConsoleMailer } from './console.mailer.js';
import { MailService } from './mail.service.js';
import { Mailer } from './mailer.js';
import { SmtpMailer } from './smtp.mailer.js';

@Global()
@Module({
  providers: [
    {
      provide: Mailer,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Mailer =>
        config.MAIL_PROVIDER === 'smtp'
          ? new SmtpMailer({
              host: config.SMTP_HOST!,
              port: config.SMTP_PORT,
              secure: config.SMTP_SECURE,
              user: config.SMTP_USER,
              password: config.SMTP_PASSWORD,
              from: config.MAIL_FROM,
              // STARTTLS is mandatory in production unless the connection is TLS from the start (SMTP_SECURE=true).
              requireTls: config.NODE_ENV === 'production',
            })
          : new ConsoleMailer(),
    },
    MailService,
  ],
  exports: [Mailer, MailService],
})
export class MailModule {}
