import { describe, expect, it } from 'vitest';
import { loadServerEnv } from './server-env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
  REDIS_URL: 'redis://localhost:6379',
  NODE_ENV: 'development',
};

describe('loadServerEnv', () => {
  it('applies defaults', () => {
    expect(loadServerEnv(valid)).toMatchObject({ API_PORT: 4000, NODE_ENV: 'development' });
  });
  it('lists every invalid variable', () => {
    expect(() => loadServerEnv({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });
});

describe('auth env', () => {
  it('requires signing keys in production', () => {
    expect(() => loadServerEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/JWT_PRIVATE_KEY/);
  });
  it('rejects a half-configured key pair', () => {
    expect(() => loadServerEnv({ ...valid, JWT_PRIVATE_KEY: 'x' })).toThrow(/both/);
  });
  it('splits WEB_ORIGINS', () => {
    expect(
      loadServerEnv({ ...valid, WEB_ORIGINS: 'http://a.test, http://b.test' }).WEB_ORIGINS,
    ).toEqual(['http://a.test', 'http://b.test']);
  });
});

describe('mail and logging env', () => {
  it('defaults to console mail and info logs outside production', () => {
    expect(loadServerEnv(valid)).toMatchObject({
      MAIL_PROVIDER: 'console',
      LOG_LEVEL: 'info',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
    });
  });
  it('requires SMTP_HOST for the smtp provider', () => {
    expect(() => loadServerEnv({ ...valid, MAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_HOST/);
  });
  it('requires SMTP credentials as a pair', () => {
    expect(() =>
      loadServerEnv({ ...valid, MAIL_PROVIDER: 'smtp', SMTP_HOST: 'h', SMTP_USER: 'u' }),
    ).toThrow(/SMTP_PASSWORD/);
  });
  it('refuses the console mail provider in production, where it would log live tokens', () => {
    const prod = { ...valid, NODE_ENV: 'production', JWT_PRIVATE_KEY: 'a', JWT_PUBLIC_KEY: 'b' };
    expect(() => loadServerEnv(prod)).toThrow(/MAIL_PROVIDER/);
    expect(
      loadServerEnv({ ...prod, MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.test' })
        .MAIL_PROVIDER,
    ).toBe('smtp');
  });
  it('requires an https API_PUBLIC_URL in production, but allows http elsewhere', () => {
    const prod = {
      ...valid,
      NODE_ENV: 'production',
      JWT_PRIVATE_KEY: 'a',
      JWT_PUBLIC_KEY: 'b',
      MAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.test',
    };
    expect(() => loadServerEnv({ ...prod, API_PUBLIC_URL: 'http://api.example.test' })).toThrow(
      /API_PUBLIC_URL/,
    );
    expect(loadServerEnv({ ...prod, API_PUBLIC_URL: 'https://api.example.test' })).toBeTruthy();
    expect(loadServerEnv({ ...valid, API_PUBLIC_URL: 'http://localhost:4000' })).toBeTruthy();
  });
  it('rejects an unknown log level', () => {
    expect(() => loadServerEnv({ ...valid, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});

describe('NODE_ENV', () => {
  it('is required, so a deploy that forgets it cannot silently run with development safeguards', () => {
    const withoutNodeEnv = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== 'NODE_ENV'),
    );
    expect(() => loadServerEnv(withoutNodeEnv)).toThrow(/NODE_ENV/);
  });
});
