// Sends one real test email through the mailer the API is configured with, and prints transport diagnostics (TLS, server
// greeting, certificate) without any secret. Exits non-zero on failure.
// Run: pnpm mail:test -- --to you@example.com [--subject "..."]
// In a deployment: docker compose exec api node apps/api/dist/scripts/mail-test.js --to you@example.com
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { createTransport } from 'nodemailer';
import { smtpTransportOptions } from '../mail/smtp.mailer.js';
import {
  formatMailReport,
  parseMailTestArgs,
  probeSmtp,
  runMailTest,
  type MailTestArgs,
} from './mail-test-lib.js';

loadDotEnv();
let args: MailTestArgs;
try {
  args = parseMailTestArgs(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  console.error('Usage: pnpm mail:test -- --to <email> [--subject "<text>"]');
  process.exit(2);
}
let env;
try {
  env = loadServerEnv();
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

const report = await runMailTest(env, args, {
  probe: (o) => probeSmtp(o),
  sendMail: async (message) => {
    if (env.MAIL_PROVIDER === 'console') {
      process.stdout.write(
        `\n[dev email] to=${message.to} subject="${message.subject}"\n${message.text}\n\n`,
      );
      return undefined;
    }
    // The same transport settings the API uses (production requires STARTTLS unless TLS from the first byte).
    const transport = createTransport(
      smtpTransportOptions({
        host: env.SMTP_HOST!,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: env.MAIL_FROM,
        requireTls: env.NODE_ENV === 'production',
      }),
    );
    try {
      const info = await transport.sendMail({ from: env.MAIL_FROM, ...message });
      return info.response;
    } finally {
      transport.close();
    }
  },
});
for (const line of formatMailReport(report)) console.log(line);
console.log(
  JSON.stringify({
    time: new Date().toISOString(),
    event: 'mail.test',
    ok: report.ok,
    provider: report.provider,
    delivered: report.delivered,
    tls: report.transport?.probe?.tls.mode ?? null,
    certificateTrusted: report.transport?.probe?.tls.certificateTrusted ?? null,
  }),
);
process.exit(report.ok ? 0 : 1);
