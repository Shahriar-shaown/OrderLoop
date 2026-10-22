import { describe, expect, it } from 'vitest';
import { loadServerEnv, registrationAllowed } from './server-env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
  REDIS_URL: 'redis://localhost:6379',
  NODE_ENV: 'development',
};

/** What production also needs on purpose: a proxy hop, explicit Meta, TikTok and sign-up modes and https origins. */
const prodExtras = {
  TRUST_PROXY: '1',
  META_MODE: 'mock',
  TIKTOK_MODE: 'mock',
  REGISTRATION_MODE: 'open',
  WEB_ORIGINS: 'https://app.example.test',
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
    const prod = {
      ...valid,
      NODE_ENV: 'production',
      ...prodExtras,
      JWT_PRIVATE_KEY: 'a',
      JWT_PUBLIC_KEY: 'b',
    };
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
      ...prodExtras,
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

describe('push and messaging env', () => {
  it('defaults to the dev push provider and unavailable sms and whatsapp, so nothing paid is needed', () => {
    expect(loadServerEnv(valid)).toMatchObject({
      PUSH_PROVIDER: 'dev',
      SMS_PROVIDER: 'none',
      WHATSAPP_PROVIDER: 'none',
    });
  });
  it('accepts expo and console, and rejects an unknown provider', () => {
    expect(
      loadServerEnv({ ...valid, PUSH_PROVIDER: 'expo', SMS_PROVIDER: 'console' }),
    ).toMatchObject({
      PUSH_PROVIDER: 'expo',
      SMS_PROVIDER: 'console',
    });
    expect(() => loadServerEnv({ ...valid, PUSH_PROVIDER: 'fcm' })).toThrow(/PUSH_PROVIDER/);
    expect(() => loadServerEnv({ ...valid, SMS_PROVIDER: 'twilio' })).toThrow(/SMS_PROVIDER/);
  });
  it('keeps the dev provider allowed in production (it is logged loudly at start-up, not refused)', () => {
    const prod = {
      ...valid,
      NODE_ENV: 'production',
      ...prodExtras,
      JWT_PRIVATE_KEY: 'a',
      JWT_PUBLIC_KEY: 'b',
      MAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.test',
    };
    expect(loadServerEnv(prod).PUSH_PROVIDER).toBe('dev');
  });
});

describe('meta env', () => {
  const live = {
    ...valid,
    META_MODE: 'live',
    META_APP_ID: '1234567890',
    META_APP_SECRET: 'a-sixteen-char-secret',
    META_WEBHOOK_VERIFY_TOKEN: 'a-sixteen-char-token',
    META_GRAPH_VERSION: 'v23.0',
    API_PUBLIC_URL: 'https://api.example.test',
    COURIER_CREDENTIALS_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  it('defaults to mock mode with 30 days of retention and needs nothing else', () => {
    expect(loadServerEnv(valid)).toMatchObject({ META_MODE: 'mock', META_RETENTION_DAYS: 30 });
  });
  it('accepts a complete live configuration', () => {
    expect(loadServerEnv(live)).toMatchObject({ META_MODE: 'live', META_GRAPH_VERSION: 'v23.0' });
  });
  it.each([
    'META_APP_ID',
    'META_APP_SECRET',
    'META_WEBHOOK_VERIFY_TOKEN',
    'META_GRAPH_VERSION',
    'API_PUBLIC_URL',
    'COURIER_CREDENTIALS_KEY',
  ])('live mode without %s fails to start and names it', (name) => {
    const env: Record<string, string | undefined> = { ...live };
    delete env[name];
    expect(() => loadServerEnv(env)).toThrow(new RegExp(`${name} is required when META_MODE=live`));
  });
  it('rejects a malformed Graph version and a non-numeric app id', () => {
    expect(() => loadServerEnv({ ...live, META_GRAPH_VERSION: '23' })).toThrow(/Graph API version/);
    expect(() => loadServerEnv({ ...live, META_APP_ID: 'abc' })).toThrow(/numeric/);
  });
});

describe('tiktok env', () => {
  const live = {
    ...valid,
    TIKTOK_MODE: 'live',
    TIKTOK_APP_KEY: '6abcdefghij',
    TIKTOK_APP_SECRET: 'a-sixteen-char-secret',
    API_PUBLIC_URL: 'https://api.test.example',
    COURIER_CREDENTIALS_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  it('defaults to mock with the documented hosts, version and retention', () => {
    expect(loadServerEnv(valid)).toMatchObject({
      TIKTOK_MODE: 'mock',
      TIKTOK_ALLOW_MOCK_IN_PRODUCTION: false,
      TIKTOK_AUTH_HOST: 'https://auth.tiktok-shops.com',
      TIKTOK_API_HOST: 'https://open-api.tiktokglobalshop.com',
      TIKTOK_API_VERSION: '202309',
      TIKTOK_RETENTION_DAYS: 180,
    });
  });
  it('accepts a complete live configuration', () => {
    expect(loadServerEnv(live)).toMatchObject({
      TIKTOK_MODE: 'live',
      TIKTOK_API_VERSION: '202309',
    });
  });
  it.each(['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET', 'API_PUBLIC_URL', 'COURIER_CREDENTIALS_KEY'])(
    'live mode without %s fails to start and names it',
    (name) => {
      const env: Record<string, string | undefined> = { ...live };
      delete env[name];
      expect(() => loadServerEnv(env)).toThrow(
        new RegExp(`${name} is required when TIKTOK_MODE=live`),
      );
    },
  );
  it('refuses a short secret, a plain-http API_PUBLIC_URL and plain-http hosts', () => {
    expect(() => loadServerEnv({ ...live, TIKTOK_APP_SECRET: 'short' })).toThrow(
      /TIKTOK_APP_SECRET/,
    );
    expect(() => loadServerEnv({ ...live, API_PUBLIC_URL: 'http://api.test.example' })).toThrow(
      /API_PUBLIC_URL must be https/,
    );
    expect(() => loadServerEnv({ ...live, TIKTOK_API_HOST: 'http://x.example' })).toThrow(/https/);
    expect(() => loadServerEnv({ ...live, TIKTOK_AUTH_HOST: 'http://x.example' })).toThrow(/https/);
    expect(() => loadServerEnv({ ...live, TIKTOK_API_VERSION: '2023' })).toThrow(/API version/);
  });
  it('keeps mirrored orders at least 30 days', () => {
    expect(() => loadServerEnv({ ...valid, TIKTOK_RETENTION_DAYS: '29' })).toThrow(
      /TIKTOK_RETENTION_DAYS/,
    );
    expect(loadServerEnv({ ...valid, TIKTOK_RETENTION_DAYS: '30' }).TIKTOK_RETENTION_DAYS).toBe(30);
  });
  it('must be chosen on purpose in production, for the API and the worker alike', () => {
    const prod = {
      ...valid,
      ...prodExtras,
      NODE_ENV: 'production',
      JWT_PRIVATE_KEY: 'a',
      JWT_PUBLIC_KEY: 'b',
      MAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.test',
    };
    const { TIKTOK_MODE: _omitted, ...without } = prod;
    void _omitted;
    expect(() => loadServerEnv(without)).toThrow(/TIKTOK_MODE must be set explicitly/);
    expect(() => loadServerEnv(without, { service: 'worker' })).toThrow(/TIKTOK_MODE/);
    expect(loadServerEnv(prod).TIKTOK_MODE).toBe('mock');
  });
});

describe('production safeguards', () => {
  const prod = {
    ...valid,
    ...prodExtras,
    NODE_ENV: 'production',
    JWT_PRIVATE_KEY: 'a',
    JWT_PUBLIC_KEY: 'b',
    MAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.test',
  };
  const without = (key: string) =>
    Object.fromEntries(Object.entries(prod).filter(([k]) => k !== key));
  it('accepts the complete production baseline', () => {
    expect(loadServerEnv(prod)).toMatchObject({
      META_MODE: 'mock',
      TRUST_PROXY: 1,
      META_ALLOW_MOCK_IN_PRODUCTION: false,
      OPENAPI_PUBLIC: true,
    });
  });
  it('requires META_MODE to be set on purpose in production, and defaults to mock elsewhere', () => {
    expect(() => loadServerEnv(without('META_MODE'))).toThrow(/META_MODE/);
    expect(loadServerEnv(valid).META_MODE).toBe('mock');
  });
  it('requires TRUST_PROXY >= 1 in production unless TRUST_PROXY_NONE_OK=true', () => {
    expect(() => loadServerEnv(without('TRUST_PROXY'))).toThrow(/TRUST_PROXY/);
    expect(() => loadServerEnv({ ...prod, TRUST_PROXY: '0' })).toThrow(/TRUST_PROXY_NONE_OK/);
    expect(loadServerEnv({ ...prod, TRUST_PROXY: '0', TRUST_PROXY_NONE_OK: 'true' })).toBeTruthy();
    expect(loadServerEnv({ ...valid, TRUST_PROXY: '0' })).toBeTruthy();
  });
  it('requires https web origins in production, but not in development', () => {
    expect(() => loadServerEnv({ ...prod, WEB_ORIGINS: 'http://app.example.test' })).toThrow(
      /WEB_ORIGINS must be https/,
    );
    expect(() =>
      loadServerEnv({ ...prod, WEB_ORIGINS: 'https://a.example.test,http://b.example.test' }),
    ).toThrow(/WEB_ORIGINS/);
    expect(() => loadServerEnv(without('WEB_ORIGINS'))).toThrow(/WEB_ORIGINS/);
    expect(() => loadServerEnv({ ...prod, WEB_APP_URL: 'http://app.example.test' })).toThrow(
      /WEB_APP_URL/,
    );
    expect(loadServerEnv({ ...valid, WEB_ORIGINS: 'http://localhost:3000' })).toBeTruthy();
  });
  it('reads the opt-in flags', () => {
    expect(
      loadServerEnv({ ...prod, META_ALLOW_MOCK_IN_PRODUCTION: 'true', OPENAPI_PUBLIC: 'false' }),
    ).toMatchObject({ META_ALLOW_MOCK_IN_PRODUCTION: true, OPENAPI_PUBLIC: false });
  });
});

describe('registration control', () => {
  it('is open by default outside production', () => {
    const env = loadServerEnv(valid);
    expect(env.REGISTRATION_MODE).toBe('open');
    expect(registrationAllowed(env, 'anyone@example.com')).toBe(true);
    expect(loadServerEnv({ ...valid, NODE_ENV: 'test' }).REGISTRATION_MODE).toBe('open');
  });
  describe('in production', () => {
    const prod = {
      ...valid,
      ...prodExtras,
      NODE_ENV: 'production',
      JWT_PRIVATE_KEY: 'a',
      JWT_PUBLIC_KEY: 'b',
      MAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.test',
    };
    const withoutMode = Object.fromEntries(
      Object.entries(prod).filter(([k]) => k !== 'REGISTRATION_MODE'),
    );
    it('refuses to start when REGISTRATION_MODE is not set, with a clear message', () => {
      expect(() => loadServerEnv(withoutMode)).toThrow(
        /REGISTRATION_MODE must be set explicitly in production/,
      );
    });
    it('accepts an explicit open or allowlist choice', () => {
      expect(loadServerEnv({ ...prod, REGISTRATION_MODE: 'open' }).REGISTRATION_MODE).toBe('open');
      expect(
        loadServerEnv({
          ...prod,
          REGISTRATION_MODE: 'allowlist',
          REGISTRATION_ALLOWED_EMAILS: 'owner@shop.test',
        }).REGISTRATION_MODE,
      ).toBe('allowlist');
    });
    it('still demands the list for allowlist', () => {
      expect(() => loadServerEnv({ ...prod, REGISTRATION_MODE: 'allowlist' })).toThrow(
        /REGISTRATION_ALLOWED_EMAILS/,
      );
    });
  });
  it('requires a non-empty list in allowlist mode', () => {
    expect(() => loadServerEnv({ ...valid, REGISTRATION_MODE: 'allowlist' })).toThrow(
      /REGISTRATION_ALLOWED_EMAILS/,
    );
    expect(() =>
      loadServerEnv({
        ...valid,
        REGISTRATION_MODE: 'allowlist',
        REGISTRATION_ALLOWED_EMAILS: ' , ',
      }),
    ).toThrow(/REGISTRATION_ALLOWED_EMAILS/);
  });
  it('rejects malformed entries and unknown modes', () => {
    expect(() =>
      loadServerEnv({
        ...valid,
        REGISTRATION_MODE: 'allowlist',
        REGISTRATION_ALLOWED_EMAILS: 'nope',
      }),
    ).toThrow(/Each entry/);
    expect(() => loadServerEnv({ ...valid, REGISTRATION_MODE: 'closed' })).toThrow(
      /REGISTRATION_MODE/,
    );
  });
  it('matches exact emails and whole domains, case-insensitively', () => {
    const env = loadServerEnv({
      ...valid,
      REGISTRATION_MODE: 'allowlist',
      REGISTRATION_ALLOWED_EMAILS: 'Owner@Shop.test, @Pilot.example',
    });
    expect(env.REGISTRATION_ALLOWED_EMAILS).toEqual(['owner@shop.test', '@pilot.example']);
    expect(registrationAllowed(env, 'OWNER@shop.test')).toBe(true);
    expect(registrationAllowed(env, 'anyone@PILOT.example')).toBe(true);
    expect(registrationAllowed(env, 'other@shop.test')).toBe(false);
    expect(registrationAllowed(env, 'x@sub.pilot.example')).toBe(false);
    expect(registrationAllowed(env, 'x@evilpilot.example')).toBe(false);
    expect(registrationAllowed(env, 'no-at-sign')).toBe(false);
  });
});

describe('metrics and worker health env', () => {
  it('leaves /metrics off (no token) and the worker health port at 4010 by default', () => {
    expect(loadServerEnv(valid)).toMatchObject({ WORKER_HEALTH_PORT: 4010 });
    expect(loadServerEnv(valid).METRICS_TOKEN).toBeUndefined();
  });
  it('accepts a long token and a port, and rejects a short token or a bad port', () => {
    expect(
      loadServerEnv({ ...valid, METRICS_TOKEN: 'a-sixteen-char-tok', WORKER_HEALTH_PORT: '4999' }),
    ).toMatchObject({ METRICS_TOKEN: 'a-sixteen-char-tok', WORKER_HEALTH_PORT: 4999 });
    expect(() => loadServerEnv({ ...valid, METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN/);
    expect(() => loadServerEnv({ ...valid, WORKER_HEALTH_PORT: '70000' })).toThrow(
      /WORKER_HEALTH_PORT/,
    );
  });
  it('never echoes the token in an error', () => {
    try {
      loadServerEnv({ ...valid, METRICS_TOKEN: 'short-secret' });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain('short-secret');
    }
  });
});

describe('blank variables', () => {
  it('are treated as not set, so Compose or an env file can pass `KEY=` safely', () => {
    const env = loadServerEnv({
      ...valid,
      SMTP_USER: '',
      SMTP_PASSWORD: '  ',
      SMTP_HOST: '',
      JWT_PRIVATE_KEY: '',
      JWT_PUBLIC_KEY: '',
      METRICS_TOKEN: '',
      LOG_LEVEL: '',
      REGISTRATION_ALLOWED_EMAILS: '',
    });
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.METRICS_TOKEN).toBeUndefined();
    expect(env.LOG_LEVEL).toBe('info');
  });
  it('do not rescue a variable that is required: blank NODE_ENV or DATABASE_URL still fails', () => {
    expect(() => loadServerEnv({ ...valid, NODE_ENV: '' })).toThrow(/NODE_ENV/);
    expect(() => loadServerEnv({ ...valid, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
  it('still fail production without an explicit REGISTRATION_MODE when it is blank', () => {
    expect(() =>
      loadServerEnv({
        ...valid,
        ...prodExtras,
        NODE_ENV: 'production',
        REGISTRATION_MODE: '',
        JWT_PRIVATE_KEY: 'a',
        JWT_PUBLIC_KEY: 'b',
        MAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.test',
      }),
    ).toThrow(/REGISTRATION_MODE must be set explicitly/);
  });
});

describe('the worker', () => {
  const workerProd = {
    ...valid,
    NODE_ENV: 'production',
    META_MODE: 'mock',
    TIKTOK_MODE: 'mock',
    MAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.test',
  };
  it('is not asked for the API-only production settings: signing keys, proxy hops, https origins, sign-up mode', () => {
    expect(() => loadServerEnv(workerProd)).toThrow(/JWT_PRIVATE_KEY/); // the API still demands them
    const env = loadServerEnv(workerProd, { service: 'worker' });
    expect(env).toMatchObject({ NODE_ENV: 'production', META_MODE: 'mock' });
    expect(env.JWT_PRIVATE_KEY).toBeUndefined();
  });
  it('still gets every shared production safeguard', () => {
    const withoutMeta = Object.fromEntries(
      Object.entries(workerProd).filter(([k]) => k !== 'META_MODE'),
    );
    expect(() => loadServerEnv(withoutMeta, { service: 'worker' })).toThrow(/META_MODE/);
    expect(() =>
      loadServerEnv({ ...workerProd, MAIL_PROVIDER: 'console' }, { service: 'worker' }),
    ).toThrow(/MAIL_PROVIDER/);
    expect(() =>
      loadServerEnv(
        { ...workerProd, API_PUBLIC_URL: 'http://api.example.test' },
        { service: 'worker' },
      ),
    ).toThrow(/API_PUBLIC_URL/);
    expect(() =>
      loadServerEnv({ ...workerProd, METRICS_TOKEN: 'short' }, { service: 'worker' }),
    ).toThrow(/METRICS_TOKEN/);
  });
});
