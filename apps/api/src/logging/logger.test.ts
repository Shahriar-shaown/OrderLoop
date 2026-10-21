import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { PinoLoggerService } from './pino-logger.service.js';
import { scrubPath, scrubSecrets } from './scrub.js';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, destination, text: () => lines.join('') };
}

describe('structured logger', () => {
  it('emits one JSON object per line with level, time and service', () => {
    const out = capture();
    createLogger({ level: 'info', destination: out.destination }).info(
      { requestId: 'r1' },
      'hello',
    );
    const line = JSON.parse(out.lines[0]!);
    expect(line).toMatchObject({
      level: 'info',
      service: 'orderloop-api',
      requestId: 'r1',
      msg: 'hello',
    });
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts credentials in structured fields, at any common nesting depth', () => {
    const out = capture();
    const log = createLogger({ level: 'info', destination: out.destination });
    log.info({
      req: {
        headers: {
          authorization: 'Bearer SECRETBEARER',
          cookie: 'ol_rt=SECRETCOOKIE',
          accept: 'json',
        },
      },
      res: { headers: { 'set-cookie': ['ol_rt=SECRETSETCOOKIE'] } },
      password: 'SECRETPW1',
      body: {
        password: 'SECRETPW2',
        refreshToken: 'SECRETRT1',
        nested: { accessToken: 'SECRETAT1' },
      },
      user: { passwordHash: 'SECRETHASH', email: 'keep@example.test' },
      newPassword: 'SECRETPW3',
    });
    const text = out.text();
    for (const secret of [
      'SECRETBEARER',
      'SECRETCOOKIE',
      'SECRETSETCOOKIE',
      'SECRETPW1',
      'SECRETPW2',
      'SECRETRT1',
      'SECRETAT1',
      'SECRETHASH',
      'SECRETPW3',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('accept'); // non-sensitive fields survive
  });

  it('scrubs secrets that appear inside error messages and stacks', () => {
    const out = capture();
    const jwt = `eyJhbGciOiJFZERTQSJ9.${'a'.repeat(30)}.${'b'.repeat(20)}`;
    const error = new Error(
      `failed for Bearer ${'x'.repeat(40)} with hash $argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g and jwt ${jwt} at postgresql://app_user:hunter2@db:5432/x`,
    );
    createLogger({ level: 'info', destination: out.destination }).error({ err: error }, 'boom');
    const text = out.text();
    for (const leak of ['x'.repeat(40), '$argon2id$', jwt, 'hunter2'])
      expect(text).not.toContain(leak);
    expect(text).toContain('boom');
  });

  it('routes Nest logger calls through redaction too', () => {
    const out = capture();
    const service = new PinoLoggerService(
      createLogger({ level: 'debug', destination: out.destination }),
    );
    service.log('token=SUPERSECRETVALUE9 issued', 'Ctx');
    service.error('exploded with password: hunter2hunter2', 'Error: x\n    at y', 'Ctx');
    service.warn({ refreshToken: 'SECRETRT2', note: 'ok' });
    const text = out.text();
    expect(text).not.toContain('SUPERSECRETVALUE9');
    expect(text).not.toContain('hunter2hunter2');
    expect(text).not.toContain('SECRETRT2');
    expect(text).toContain('Ctx');
  });

  it('respects the configured level', () => {
    const out = capture();
    const log = createLogger({ level: 'warn', destination: out.destination });
    log.info('quiet');
    log.warn('loud');
    expect(out.lines).toHaveLength(1);
  });
});

describe('scrubSecrets', () => {
  it('masks opaque 256-bit tokens, invitations and connection strings', () => {
    const token = 'A'.repeat(43);
    const inv = `inv_0197b0a0-0000-7000-8000-000000000001_${'B'.repeat(43)}`;
    const out = scrubSecrets(`t=${token} i=${inv} url=redis://default:pw@cache:6379`);
    expect(out).not.toContain(token);
    expect(out).not.toContain(inv);
    expect(out).not.toContain(':pw@');
  });
  it('masks email addresses, including when a provider error quotes one', () => {
    const out = scrubSecrets(
      '550 5.1.1 <victim.name+tag@mail.example.test>: Recipient address rejected',
    );
    expect(out).not.toContain('victim.name');
    expect(out).toContain('Recipient address rejected');
    expect(scrubSecrets('postgresql://app_user:pw@db:5432/x')).not.toContain(':pw@'); // not mistaken for an address
  });
  it('leaves ordinary text alone', () => {
    expect(scrubSecrets('Unique constraint failed on users_email_key')).toBe(
      'Unique constraint failed on users_email_key',
    );
  });
});

describe('scrubPath', () => {
  it('hides the push token and any long opaque segment, keeps routes and ids', () => {
    expect(scrubPath('/v1/push-devices/ExponentPushToken%5BabcDEF123%5D')).toBe(
      '/v1/push-devices/[REDACTED]',
    );
    expect(scrubPath('/v1/push-devices/x')).toBe('/v1/push-devices/[REDACTED]');
    expect(scrubPath('/v1/things/abcdefghij0123456789ABCDEFGHIJ0123456789abc')).toBe(
      '/v1/things/[REDACTED]',
    );
    const id = '0190f2c4-7a2b-7c11-9d3e-5f6a7b8c9d0e';
    expect(scrubPath(`/v1/orders/${id}/status-history`)).toBe(`/v1/orders/${id}/status-history`);
    expect(scrubPath('/v1/webhooks/couriers/steadfast/' + id + '/' + id)).toBe(
      '/v1/webhooks/couriers/steadfast/' + id + '/' + id,
    );
    expect(scrubPath('/health/ready')).toBe('/health/ready');
  });
});
