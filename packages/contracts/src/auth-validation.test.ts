import { describe, expect, it } from 'vitest';
import { ForgotPasswordBody, LoginBody, Password, RegisterBody } from './auth.js';

/** The first message for each field, which is what a form shows. */
function firstErrors(
  schema: {
    safeParse(v: unknown): {
      success: boolean;
      error?: { issues: { path: PropertyKey[]; message: string }[] };
    };
  },
  value: unknown,
) {
  const result = schema.safeParse(value);
  const out: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) out[issue.path.join('.')] ??= issue.message;
  return out;
}

const valid = {
  name: 'Rina Akter',
  tenantName: 'Rina Fashion',
  email: 'rina@example.com',
  password: 'Str0ng!pass',
};

describe('sign-up validation messages', () => {
  it('says what is missing when everything is empty', () => {
    expect(
      firstErrors(RegisterBody, { name: '', tenantName: '', email: '', password: '' }),
    ).toEqual({
      name: 'Name is required',
      tenantName: 'Business name is required',
      email: 'Email is required',
      password: 'Password is required',
    });
  });

  it('requires names of at least 3 characters (after trimming)', () => {
    expect(firstErrors(RegisterBody, { ...valid, name: 'Al', tenantName: '  ab ' })).toEqual({
      name: 'Name must be at least 3 characters',
      tenantName: 'Business name must be at least 3 characters',
    });
    expect(firstErrors(RegisterBody, { ...valid, name: 'Ali' })).toEqual({});
  });

  it('asks for a valid email address', () => {
    expect(firstErrors(RegisterBody, { ...valid, email: 'not-an-email' })).toEqual({
      email: 'Enter a valid email address',
    });
  });

  it('accepts a well-formed sign-up', () => {
    expect(RegisterBody.safeParse(valid).success).toBe(true);
  });
});

describe('Password rule', () => {
  const message = (p: string) => firstErrors({ safeParse: (v) => Password.safeParse(v) }, p)[''];

  it('needs 8 characters, an uppercase letter, a number and a special character, reporting the first one missing', () => {
    expect(message('')).toBe('Password is required');
    expect(message('Ab1!')).toBe('Password must be at least 8 characters');
    expect(message('abcdefg1!')).toBe('Password must include an uppercase letter');
    expect(message('Abcdefgh!')).toBe('Password must include a number');
    expect(message('Abcdefg12')).toBe('Password must include a special character');
    expect(message('Abcdef1!')).toBeUndefined();
  });

  it('caps the length so hashing cannot be abused', () => {
    expect(message(`Aa1!${'x'.repeat(125)}`)).toBe('Password must be at most 128 characters');
  });
});

describe('other forms', () => {
  it('sign-in only asks for the fields, never revealing the password rule', () => {
    expect(firstErrors(LoginBody, { email: '', password: '' })).toEqual({
      email: 'Email is required',
      password: 'Password is required',
    });
    expect(LoginBody.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
  });

  it('forgot-password asks for an email', () => {
    expect(firstErrors(ForgotPasswordBody, { email: '' })).toEqual({ email: 'Email is required' });
  });
});
