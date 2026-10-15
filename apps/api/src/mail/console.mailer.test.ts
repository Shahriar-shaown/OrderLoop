import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleMailer } from './console.mailer.js';
import { templates } from './templates.js';

describe('ConsoleMailer (development only)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints the complete, usable link to the terminal, not through the redacting logger', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const token = 'abcDEF0123456789abcDEF0123456789abcDEF01234'; // 43 chars, like a real token
    await new ConsoleMailer().send(
      templates.passwordReset('dev@example.test', 'http://localhost:3000', token),
    );
    const out = written.join('');
    expect(out).toContain('to=dev@example.test');
    expect(out).toContain(`http://localhost:3000/reset-password?token=${token}`); // intact: a developer must be able to use it
    expect(out).not.toContain('REDACTED');
  });
});
