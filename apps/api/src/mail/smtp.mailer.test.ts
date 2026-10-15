import 'reflect-metadata';
import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { MailService } from './mail.service.js';
import { MemoryMailer } from './memory.mailer.js';
import { SmtpMailer } from './smtp.mailer.js';
import { templates } from './templates.js';

describe('SmtpMailer', () => {
  it('hands the message to the transport with the configured sender', async () => {
    const transport = createTransport({ jsonTransport: true });
    const sent: { from: string; to: string; subject: string }[] = [];
    const original = transport.sendMail.bind(transport);
    transport.sendMail = (async (m: never) => {
      sent.push(m);
      return original(m);
    }) as typeof transport.sendMail;
    const mailer = new SmtpMailer(
      { host: 'x', port: 25, secure: false, from: 'OrderLoop <hello@example.test>' },
      transport,
    );
    await mailer.send(templates.passwordChanged('a@b.test'));
    expect(sent).toEqual([
      expect.objectContaining({
        from: 'OrderLoop <hello@example.test>',
        to: 'a@b.test',
        subject: 'Your OrderLoop password was changed',
      }),
    ]);
  });
});

describe('MailService', () => {
  it('never throws when the provider fails, and never logs the token or address, even if the provider error quotes it', async () => {
    const failing = {
      send: async () => {
        throw new Error('connect ECONNREFUSED while delivering to <victim@example.test>');
      },
    };
    const logged: string[] = [];
    const service = new MailService(failing as never);
    (service as unknown as { logger: { error: (m: string) => void } }).logger = {
      error: (m) => logged.push(m),
    };
    const message = templates.passwordReset(
      'victim@example.test',
      'https://app.example.test',
      'SECRET-TOKEN-VALUE-1234567890',
    );
    expect(await service.send(message)).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('ECONNREFUSED');
    expect(logged[0]).not.toContain('SECRET-TOKEN-VALUE');
    expect(logged[0]).not.toContain('victim@example.test');
  });

  it('reports success', async () => {
    const memory = new MemoryMailer();
    expect(await new MailService(memory).send(templates.passwordChanged('a@b.test'))).toBe(true);
    expect(memory.to('a@b.test')).toHaveLength(1);
  });

  it('MemoryMailer extracts tokens and fails loudly when there is none', () => {
    const memory = new MemoryMailer();
    void memory.send(
      templates.verifyEmail('a@b.test', 'https://x.test', 'abc_DEF-123456789012345'),
    );
    expect(memory.tokenFor('a@b.test', 'verify_email')).toBe('abc_DEF-123456789012345');
    expect(() => memory.tokenFor('a@b.test', 'password_reset')).toThrow(/No password_reset email/);
  });
});
