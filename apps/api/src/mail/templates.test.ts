import { describe, expect, it } from 'vitest';
import { templates } from './templates.js';

describe('email templates', () => {
  it('put the token in a link on the web origin, URL-encoded', () => {
    const m = templates.passwordReset('a@b.test', 'https://app.example.test', 'tok/with+chars=');
    expect(m.text).toContain('https://app.example.test/reset-password?token=tok%2Fwith%2Bchars%3D');
    expect(m.kind).toBe('password_reset');
    expect(m.html).toContain(
      'href="https://app.example.test/reset-password?token=tok%2Fwith%2Bchars%3D"',
    );
  });

  it('escape HTML in every interpolated value', () => {
    const m = templates.invitation(
      'a@b.test',
      'https://app.example.test',
      'abcdefghijklmnopqrstuvwxyz',
      '<img src=x onerror=alert(1)>',
    );
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;img');
  });

  it('take no account name, so a stranger who registers your address cannot put their own words in our email', () => {
    expect(templates.verifyEmail.length).toBe(3); // (to, base, token): no name parameter
    expect(templates.passwordReset.length).toBe(3);
    expect(templates.passwordChanged.length).toBe(1);
  });

  it('the verification email tells a wrongly addressed recipient to ignore it', () => {
    expect(
      templates.verifyEmail('a@b.test', 'https://x.test', 'abcdefghijklmnopqrstuvwxyz').text,
    ).toMatch(/If it was not you, ignore this email/);
  });

  it('the password-changed notice carries no token or link', () => {
    const m = templates.passwordChanged('a@b.test');
    expect(m.text).not.toMatch(/token=|https?:\/\//);
  });

  it('the deletion emails carry no token and no business name', () => {
    const closed = templates.accountDeleted('a@b.test');
    expect(closed.text).not.toMatch(/token=|https?:\/\//);
    expect(closed.kind).toBe('account_deleted');
    const scheduled = templates.tenantDeletionScheduled(
      'a@b.test',
      'https://app.example.test',
      new Date('2026-11-05T10:00:00Z'),
    );
    expect(scheduled.text).toContain('2026-11-05');
    expect(scheduled.text).not.toMatch(/token=/);
    expect(templates.tenantDeletionScheduled.length).toBe(3); // (to, base, date): no name parameter
  });
});
