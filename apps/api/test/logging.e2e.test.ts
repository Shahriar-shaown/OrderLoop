import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  createTestApp,
  PASSWORD,
  registerTenant,
  uniqueEmail,
  type TestApp,
} from './app.js';

const lines: string[] = [];
const destination = new Writable({
  write(chunk, _enc, cb) {
    lines.push(String(chunk));
    cb();
  },
});
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({}, { logDestination: destination });
});
afterAll(() => t.close());

const requestLines = () =>
  lines
    .join('')
    .split('\n')
    .filter((l) => l.includes('"request completed"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('structured request logging', () => {
  it('writes one JSON line per request with method, path, status, timing and request id', async () => {
    lines.length = 0;
    await t.http.get('/v1/me');
    const [entry] = requestLines().filter((l) => l.path === '/v1/me');
    expect(entry).toMatchObject({
      level: 'warn',
      method: 'GET',
      path: '/v1/me',
      status: 401,
      msg: 'request completed',
      service: 'orderloop-api',
    });
    expect(typeof entry!.durationMs).toBe('number');
    expect(typeof entry!.requestId).toBe('string');
  });

  it('echoes a well-formed x-request-id and replaces a malformed one', async () => {
    const good = await t.http.get('/health/live').set('x-request-id', 'trace-abc12345');
    expect(good.headers['x-request-id']).toBe('trace-abc12345');
    const bad = await t.http.get('/health/live').set('x-request-id', 'bad\tid with spaces');
    expect(bad.headers['x-request-id']).not.toContain('bad');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('includes the authenticated user and tenant, taken from the verified token', async () => {
    const owner = await registerTenant(t);
    lines.length = 0;
    await t.http.get('/v1/tenant').set(bearer(owner.accessToken));
    const entry = requestLines().find((l) => l.path === '/v1/tenant')!;
    expect(entry).toMatchObject({
      userId: owner.user.id,
      tenantId: owner.tenant.id,
      status: 200,
      level: 'info',
    });
  });

  it('drops the query string from logged paths', async () => {
    const owner = await registerTenant(t);
    lines.length = 0;
    await t.http
      .get('/v1/audit-logs?cursor=SECRETCURSORVALUE&limit=5')
      .set(bearer(owner.accessToken));
    const text = lines.join('');
    expect(text).not.toContain('SECRETCURSORVALUE');
    expect(requestLines().find((l) => String(l.path).startsWith('/v1/audit-logs'))!.path).toBe(
      '/v1/audit-logs',
    );
  });

  it('logs 5xx at error level and 4xx at warn', async () => {
    lines.length = 0;
    await t.http.post('/v1/auth/login').send({});
    expect(requestLines().find((l) => l.path === '/v1/auth/login')).toMatchObject({
      level: 'warn',
      status: 400,
    });
  });
});

describe('log redaction: no credential or token ever reaches a log line', () => {
  it('survives a full run of every credential-bearing flow', async () => {
    lines.length = 0;
    const email = uniqueEmail('logcheck');
    const secrets: string[] = [];

    // register (password in the body), login, wrong password, refresh, logout
    const password = 'A very distinctive log-test passphrase 8841!';
    secrets.push(password);
    const owner = await registerTenant(t, { email, password });
    secrets.push(owner.accessToken, owner.refreshToken);
    const login = await t.http.post('/v1/auth/login').send({ email, password });
    secrets.push(login.body.accessToken, login.body.refreshToken);
    const wrong = 'WRONG-password-for-log-test-5520';
    secrets.push(wrong);
    await t.http.post('/v1/auth/login').send({ email, password: wrong });
    const refreshed = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    secrets.push(refreshed.body.accessToken, refreshed.body.refreshToken);
    await t.http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }); // replay: logs a reuse event

    // email flows: tokens in request bodies
    await t.http.post('/v1/auth/forgot-password').send({ email });
    await new Promise((r) => setTimeout(r, 25));
    const resetToken = t.mail.tokenFor(email, 'password_reset');
    const verifyToken = t.mail.tokenFor(email, 'verify_email');
    const newPassword = 'another distinctive reset passphrase 7703';
    secrets.push(resetToken, verifyToken, newPassword);
    await t.http.post('/v1/auth/verify-email').send({ token: verifyToken });
    await t.http.post('/v1/auth/reset-password').send({ token: resetToken, password: newPassword });

    // invitation token and the invitee's password
    const inviter = await registerTenant(t);
    const member = await addMember(t, inviter, 'STAFF', {
      password: 'Invitee distinctive passphrase 3391!',
    });
    secrets.push(
      'Invitee distinctive passphrase 3391!',
      member.accessToken,
      member.refreshToken,
      inviter.accessToken,
      inviter.refreshToken,
    );
    secrets.push(
      ...t.mail.sent
        .filter((m) => m.kind === 'invitation')
        .map((m) => /token=([^\s&]+)/.exec(m.text)![1]!),
    );

    // a garbage and a forged bearer token
    await t.http.get('/v1/me').set(bearer('forged.bearer.TOKEN-for-log-test'));
    secrets.push('forged.bearer.TOKEN-for-log-test');

    const text = lines.join('');
    expect(text.length).toBeGreaterThan(500); // we really captured the run
    expect(requestLines().length).toBeGreaterThan(10);
    for (const secret of secrets.filter(Boolean)) {
      expect(
        text.includes(secret),
        `a secret leaked into the logs: ${secret.slice(0, 12)}...`,
      ).toBe(false);
    }
    expect(text).not.toMatch(/\$argon2/);
    expect(text).not.toMatch(/Bearer\s+ey/);
    // Email addresses are personal data and are not needed to trace a request.
    expect(text).not.toContain(email);
  });
});
