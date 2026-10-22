import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * TikTok Shop's two signature schemes. Both are read from the EcomPHP/tiktokshop-php SDK source (src/Client.php
 * prepareSignature, src/Webhook.php verify) and cross-checked with a second, independent SDK (hsib19/tiktok-shop-sdk) and with
 * Hookdeck's webhook guide. NOT checked against TikTok's own documentation (it is JavaScript-rendered and could not be read):
 * verify before going live, see docs/tiktok-shop.md.
 */

const hmacHex = (data: string | Buffer, secret: string) =>
  createHmac('sha256', secret).update(data).digest('hex');

/** Query parameters TikTok leaves out of the signed string. */
const UNSIGNED_PARAMS = new Set(['sign', 'access_token', 'x-tts-access-token']);

export interface RequestToSign {
  /** The request PATH only, e.g. `/order/202309/orders/search` (no host, no query). */
  path: string;
  /** Every query parameter that will be sent (`app_key`, `timestamp`, `shop_cipher`, ...). `sign` and tokens are skipped. */
  query: Readonly<Record<string, string | undefined>>;
  /** The exact body that will be sent, for requests that are not GET and not multipart; empty otherwise. */
  body?: string;
  appSecret: string;
}

/**
 * The `sign` query parameter of an API request: take every query parameter except `sign`, `access_token` and
 * `x-tts-access-token`, sort by key, concatenate `key` + `value`, put the request path in front and the raw body (if any) behind,
 * wrap the whole string in the app secret on both sides, and HMAC-SHA256 it with the app secret as the key (lowercase hex).
 */
export function tiktokRequestSignature(req: RequestToSign): string {
  const joined = Object.entries(req.query)
    .filter((e): e is [string, string] => e[1] !== undefined && !UNSIGNED_PARAMS.has(e[0]))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}${v}`)
    .join('');
  const toSign = `${req.appSecret}${req.path}${joined}${req.body ?? ''}${req.appSecret}`;
  return hmacHex(toSign, req.appSecret);
}

/** The `Authorization` header value of a webhook delivery: lowercase hex HMAC-SHA256 over `app_key + rawBody`, keyed with the app secret. */
export function tiktokWebhookSignature(
  raw: string | Buffer,
  appKey: string,
  appSecret: string,
): string {
  return hmacHex(Buffer.concat([Buffer.from(appKey), Buffer.from(raw)]), appSecret);
}

/**
 * Check a delivery's `Authorization` header against the RAW request bytes, in constant time, before anything is parsed. The
 * header carries the bare digest (no `Bearer`). Missing, malformed, wrong-length or wrong digests are all just `false`.
 */
export function verifyTikTokWebhook(
  raw: Buffer,
  header: string | string[] | undefined,
  appKey: string,
  appSecret: string,
): boolean {
  if (typeof header !== 'string' || !/^[0-9a-fA-F]{64}$/.test(header)) return false;
  const given = Buffer.from(header, 'hex');
  const expected = Buffer.from(tiktokWebhookSignature(raw, appKey, appSecret), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
