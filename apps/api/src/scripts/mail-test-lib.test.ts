import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatMailReport,
  parseEhlo,
  parseMailTestArgs,
  probeSmtp,
  redactDiagnostic,
  runMailTest,
  type MailTestDeps,
  type MailTestEnv,
  type SmtpProbe,
} from './mail-test-lib.js';

describe('parseMailTestArgs', () => {
  it('needs --to and accepts the forms pnpm produces', () => {
    expect(parseMailTestArgs(['--to', 'me@example.com'])).toEqual({
      to: 'me@example.com',
      subject: 'OrderLoop test email',
    });
    expect(parseMailTestArgs(['--', '--to=me@example.com', '--subject', 'Hi'])).toEqual({
      to: 'me@example.com',
      subject: 'Hi',
    });
    expect(() => parseMailTestArgs([])).toThrow(/--to/);
  });
  it('refuses a bad address, header injection, a missing value and unknown flags', () => {
    expect(() => parseMailTestArgs(['--to', 'not-an-email'])).toThrow(/valid email/);
    expect(() => parseMailTestArgs(['--to', 'a@b.co,c@d.co'])).toThrow(/valid email/);
    expect(() => parseMailTestArgs(['--to', 'a@b.co', '--subject', 'x\r\nBcc: z@z.zz'])).toThrow(
      /one line/,
    );
    expect(() => parseMailTestArgs(['--to'])).toThrow(/needs a value/);
    expect(() => parseMailTestArgs(['--to', 'a@b.co', '--password', 'x'])).toThrow(
      /Unknown argument/,
    );
  });
});

describe('parseEhlo', () => {
  it('reads STARTTLS, AUTH and SIZE', () => {
    expect(
      parseEhlo([
        '250-mail.example.test',
        '250-STARTTLS',
        '250-AUTH PLAIN LOGIN',
        '250 SIZE 10485760',
      ]),
    ).toEqual({
      starttlsOffered: true,
      authMechanisms: ['PLAIN', 'LOGIN'],
      maxSizeBytes: 10485760,
    });
    expect(parseEhlo(['250 mail.example.test'])).toEqual({
      starttlsOffered: false,
      authMechanisms: [],
    });
  });
});

describe('redactDiagnostic', () => {
  it('removes the configured secrets and anything token-shaped', () => {
    const out = redactDiagnostic(
      'Invalid login: 535 for user smtp-user password=hunter2 token abcdefghijklmnopqrstuvwxyz0123456789ABCD',
      ['hunter2-real', 'smtp-user'],
    );
    expect(out).not.toMatch(/smtp-user|hunter2|abcdefghijklmnop/);
  });
});

const probe: SmtpProbe = {
  banner: 'mail.example.test ESMTP',
  starttlsOffered: true,
  authMechanisms: ['PLAIN'],
  tls: {
    mode: 'starttls',
    protocol: 'TLSv1.3',
    cipher: 'TLS_AES_256_GCM_SHA384',
    certificateTrusted: true,
    certificateSubject: 'mail.example.test',
  },
};
const env: MailTestEnv = {
  MAIL_PROVIDER: 'smtp',
  MAIL_FROM: 'OrderLoop <no-reply@example.test>',
  SMTP_HOST: 'mail.example.test',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: 'api-user-1234',
  SMTP_PASSWORD: 'super-secret-password',
  NODE_ENV: 'production',
};
const args = { to: 'me@example.com', subject: 'OrderLoop test email' };

describe('runMailTest', () => {
  it('reports success with TLS diagnostics and no secret anywhere in the output', async () => {
    const sent: string[] = [];
    const deps: MailTestDeps = {
      probe: async () => probe,
      sendMail: async (m) => {
        sent.push(m.to);
        return '250 2.0.0 Ok: queued as ABC123';
      },
      now: () => new Date('2026-10-21T10:00:00Z'),
    };
    const r = await runMailTest(env, args, deps);
    expect(r).toMatchObject({ ok: true, delivered: true, provider: 'smtp' });
    expect(r.transport).toMatchObject({ starttlsRequiredByApp: true, authConfigured: true });
    expect(sent).toEqual(['me@example.com']);
    const all = JSON.stringify(r) + formatMailReport(r).join('\n');
    expect(all).toContain('TLSv1.3');
    expect(all).toContain('mail.example.test ESMTP');
    expect(all).not.toContain('super-secret-password');
    expect(all).not.toContain('api-user-1234');
  });

  it('fails (and says why, redacted) when the server refuses', async () => {
    const r = await runMailTest(env, args, {
      probe: async () => probe,
      sendMail: async () => {
        throw new Error(
          'Invalid login: 535 5.7.8 Authentication failed for api-user-1234 super-secret-password',
        );
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('535');
    expect(JSON.stringify(r)).not.toMatch(/super-secret-password|api-user-1234/);
    expect(formatMailReport(r).join('\n')).toContain('FAILED');
  });

  it('records a failed probe but still attempts the real send', async () => {
    const r = await runMailTest(env, args, {
      probe: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:587');
      },
      sendMail: async () => '250 ok',
    });
    expect(r.ok).toBe(true);
    expect(r.transport?.probeError).toContain('ECONNREFUSED');
  });

  it('warns about an untrusted certificate and an unencrypted connection', async () => {
    const r = await runMailTest(env, args, {
      probe: async () => ({
        ...probe,
        tls: {
          mode: 'starttls',
          certificateTrusted: false,
          certificateProblem: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        },
      }),
      sendMail: async () => undefined,
    });
    expect(r.warnings.join(' ')).toMatch(/not trusted/);
    const plain = await runMailTest(env, args, {
      probe: async () => ({ ...probe, tls: { mode: 'none' } }),
      sendMail: async () => undefined,
    });
    expect(plain.warnings.join(' ')).toMatch(/NOT encrypted/);
  });

  it('with the console provider prints only, and says nothing was sent', async () => {
    let probed = false;
    const r = await runMailTest({ ...env, MAIL_PROVIDER: 'console' }, args, {
      probe: async () => {
        probed = true;
        return probe;
      },
      sendMail: async () => undefined,
    });
    expect(probed).toBe(false);
    expect(r).toMatchObject({ ok: true, delivered: false, provider: 'console' });
    expect(r.warnings[0]).toMatch(/not sent/);
  });
});

describe('probeSmtp against a fake server', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());
  const listen = (offerStarttls: boolean) =>
    new Promise<number>((resolve) => {
      server = createServer((socket) => {
        socket.on('error', () => undefined); // the probe hangs up right after QUIT
        socket.write('220 fake.example.test ESMTP ready\r\n');
        socket.on('data', (chunk) => {
          const text = chunk.toString();
          if (text.startsWith('EHLO'))
            socket.write(
              `250-fake.example.test\r\n${offerStarttls ? '250-STARTTLS\r\n' : ''}250-AUTH LOGIN PLAIN\r\n250 SIZE 5000000\r\n`,
            );
          else if (text.startsWith('QUIT')) socket.end('221 bye\r\n');
        });
      }).listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
    });

  it('reads the greeting and capabilities, and reports no TLS when none is offered', async () => {
    const port = await listen(false);
    const p = await probeSmtp({ host: '127.0.0.1', port, secure: false, timeoutMs: 2000 });
    expect(p).toMatchObject({
      banner: 'fake.example.test ESMTP ready',
      starttlsOffered: false,
      authMechanisms: ['LOGIN', 'PLAIN'],
      maxSizeBytes: 5000000,
      tls: { mode: 'none' },
    });
  });

  it('fails clearly when nothing listens', async () => {
    await expect(
      probeSmtp({ host: '127.0.0.1', port: 1, secure: false, timeoutMs: 500 }),
    ).rejects.toThrow();
  });
});
