import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  PASSWORD,
  registerTenant,
  uniqueEmail,
  type TestApp,
  createTestApp,
} from './app.js';

const LISTED = `pilot-owner-${Date.now()}@example.test`;
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    REGISTRATION_MODE: 'allowlist',
    REGISTRATION_ALLOWED_EMAILS: `${LISTED.toUpperCase()}, @pilot-company.test`,
  });
});
afterAll(() => t.close());

const attempt = (email: string) =>
  t.http
    .post('/v1/auth/register')
    .send({ email, password: PASSWORD, name: 'Someone', tenantName: 'Some Shop' });

describe('REGISTRATION_MODE=allowlist', () => {
  it('refuses an email that is not listed with 403 registration_closed and creates nothing', async () => {
    const email = uniqueEmail('stranger');
    const res = await attempt(email);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('registration_closed');
    expect(JSON.stringify(res.body)).not.toContain('pilot-company');
    expect(JSON.stringify(res.body)).not.toContain(LISTED);
    expect(await t.db.global.user.findUnique({ where: { email } })).toBeNull();
    expect(t.mail.tokenFor).toBeDefined();
  });

  it('lets a listed email (case-insensitive) and a listed domain register as before', async () => {
    const owner = await registerTenant(t, { email: LISTED });
    expect(owner.role).toBe('OWNER');
    const byDomain = await attempt(`anyone-${Date.now()}@Pilot-Company.test`);
    expect(byDomain.status).toBe(201);
  });

  it('does not block an invited email from accepting an invitation, and sign-in still works', async () => {
    const owner = await registerTenant(t, { email: `owner-${Date.now()}@pilot-company.test` });
    const invited = uniqueEmail('invited'); // not on the list
    expect((await attempt(invited)).status).toBe(403);
    const member = await addMember(t, owner, 'STAFF', { email: invited });
    expect(member.role).toBe('STAFF');
    const login = await t.http.post('/v1/auth/login').send({ email: invited, password: PASSWORD });
    expect(login.status).toBe(200);
  });
});
