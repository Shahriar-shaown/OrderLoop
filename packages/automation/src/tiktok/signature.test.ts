import { describe, expect, it } from 'vitest';
import {
  tiktokRequestSignature,
  tiktokWebhookSignature,
  verifyTikTokWebhook,
} from './signature.js';

const SECRET = 'sekret0123456789ab';
const KEY = '6abc12';

describe('request signature', () => {
  // Vectors computed independently with Python's hmac/hashlib from the algorithm in the SDK source: sort the query by key,
  // join key+value, prepend the path, append the body, wrap in the secret, HMAC-SHA256 keyed with the secret.
  it('matches a known vector for a POST with a body (sign and access_token are not signed)', () => {
    const sign = tiktokRequestSignature({
      path: '/order/202309/orders/search',
      query: {
        app_key: KEY,
        timestamp: '1700000000',
        shop_cipher: 'ROW_AbCdEf',
        page_size: '20',
        sort_field: 'update_time',
        sign: 'IGNORED',
        access_token: 'IGNORED',
      },
      body: '{"order_status":"AWAITING_SHIPMENT","update_time_ge":1699990000}',
      appSecret: SECRET,
    });
    expect(sign).toBe('3e1b5470b588589befd89f7fa9ea147c628197e59825c2f116c016054bf5f273');
  });

  it('matches a known vector for a GET (no body)', () => {
    const sign = tiktokRequestSignature({
      path: '/order/202309/orders',
      query: {
        timestamp: '1700000000',
        version: '202309',
        app_key: KEY,
        shop_cipher: 'ROW_AbCdEf',
        ids: '576461413038785752,576461413038785753',
        'x-tts-access-token': 'IGNORED',
      },
      appSecret: SECRET,
    });
    expect(sign).toBe('4a05e35e33d6b71283b90af05bc023fa1df0a99c60b04b5f028c466bc9fcbe47');
  });

  it('does not depend on the order the parameters were given in, and changes with every input', () => {
    const base = {
      path: '/authorization/202309/shops',
      query: { app_key: KEY, timestamp: '1', shop_cipher: 'x' },
      appSecret: SECRET,
    };
    const a = tiktokRequestSignature(base);
    expect(
      tiktokRequestSignature({
        ...base,
        query: { shop_cipher: 'x', timestamp: '1', app_key: KEY },
      }),
    ).toBe(a);
    expect(tiktokRequestSignature({ ...base, path: '/authorization/202309/other' })).not.toBe(a);
    expect(tiktokRequestSignature({ ...base, query: { ...base.query, timestamp: '2' } })).not.toBe(
      a,
    );
    expect(tiktokRequestSignature({ ...base, body: '{}' })).not.toBe(a);
    expect(tiktokRequestSignature({ ...base, appSecret: `${SECRET}x` })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips parameters that are undefined', () => {
    const a = tiktokRequestSignature({
      path: '/p',
      query: { app_key: KEY, shop_cipher: undefined },
      appSecret: SECRET,
    });
    const b = tiktokRequestSignature({ path: '/p', query: { app_key: KEY }, appSecret: SECRET });
    expect(a).toBe(b);
  });
});

describe('webhook signature', () => {
  const body =
    '{"type":1,"tts_notification_id":"7123456789","shop_id":"7494111111","timestamp":1700000000,"data":{"order_id":"5764","order_status":"AWAITING_SHIPMENT","update_time":1700000000}}';
  const good = 'a52489d6868a6e8f2938c3bc71710ee2373cdf7839c102af74b99e2d5a3793bb';
  const raw = Buffer.from(body);

  it('matches a known vector (HMAC-SHA256 over app_key + raw body, keyed with the app secret)', () => {
    expect(tiktokWebhookSignature(body, KEY, SECRET)).toBe(good);
    expect(tiktokWebhookSignature(raw, KEY, SECRET)).toBe(good);
  });

  it('accepts the right digest', () => {
    expect(verifyTikTokWebhook(raw, good, KEY, SECRET)).toBe(true);
    expect(verifyTikTokWebhook(raw, good.toUpperCase(), KEY, SECRET)).toBe(true);
  });

  it('rejects a wrong secret, a wrong app key, a tampered body and a missing or malformed header', () => {
    expect(verifyTikTokWebhook(raw, good, KEY, `${SECRET}x`)).toBe(false);
    expect(verifyTikTokWebhook(raw, good, '6abc13', SECRET)).toBe(false);
    expect(verifyTikTokWebhook(Buffer.from(body.replace('5764', '5765')), good, KEY, SECRET)).toBe(
      false,
    );
    expect(verifyTikTokWebhook(Buffer.from(`${body} `), good, KEY, SECRET)).toBe(false);
    expect(verifyTikTokWebhook(raw, undefined, KEY, SECRET)).toBe(false);
    expect(verifyTikTokWebhook(raw, '', KEY, SECRET)).toBe(false);
    expect(verifyTikTokWebhook(raw, `Bearer ${good}`, KEY, SECRET)).toBe(false);
    expect(verifyTikTokWebhook(raw, good.slice(0, 62), KEY, SECRET)).toBe(false);
    expect(verifyTikTokWebhook(raw, `${good}00`, KEY, SECRET)).toBe(false);
    expect(verifyTikTokWebhook(raw, 'z'.repeat(64), KEY, SECRET)).toBe(false);
    expect(verifyTikTokWebhook(raw, [good, good], KEY, SECRET)).toBe(false);
    expect(verifyTikTokWebhook(Buffer.alloc(0), good, KEY, SECRET)).toBe(false);
  });

  it('is computed over the raw bytes, not a re-serialisation of the parsed JSON', () => {
    const spaced = '{ "type": 1, "shop_id": "7494111111" }';
    const sig = tiktokWebhookSignature(spaced, KEY, SECRET);
    expect(verifyTikTokWebhook(Buffer.from(spaced), sig, KEY, SECRET)).toBe(true);
    expect(
      verifyTikTokWebhook(Buffer.from(JSON.stringify(JSON.parse(spaced))), sig, KEY, SECRET),
    ).toBe(false);
  });

  it('compares with a constant-time primitive (no early exit on the first differing byte)', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./signature.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('timingSafeEqual(given, expected)');
    expect(src).not.toMatch(/header\s*===|===\s*header/);
  });
});
