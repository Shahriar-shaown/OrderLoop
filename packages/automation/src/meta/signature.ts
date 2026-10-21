import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison that does not leak the length (both sides are hashed first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Non-ASCII characters as lowercase `\uXXXX` (one per UTF-16 code unit), the form Meta's docs say the signature is computed over. */
export function escapeNonAscii(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code > 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : text[i];
  }
  return out;
}

const hmacHex = (data: string | Buffer, secret: string) =>
  createHmac('sha256', secret).update(data).digest('hex');

/** `sha256=<hex>`: the X-Hub-Signature-256 value for a payload. Used by tests and the local helper that sends signed samples. */
export function hubSignature(payload: string | Buffer, secret: string, escaped = false): string {
  const data = escaped
    ? escapeNonAscii(Buffer.isBuffer(payload) ? payload.toString('utf8') : payload)
    : payload;
  return `sha256=${hmacHex(data, secret)}`;
}

/**
 * Check X-Hub-Signature-256 against the RAW request bytes. Meta's documentation says the digest is computed over the payload
 * with non-ASCII escaped as \uXXXX, but the raw bytes are what arrives, so both are accepted (verify before relying: which
 * one Meta really uses may depend on the payload). Constant-time; nothing is parsed here.
 */
export function verifyHubSignature(
  raw: Buffer,
  header: string | string[] | undefined,
  appSecret: string,
): boolean {
  if (typeof header !== 'string' || !/^sha256=[0-9a-fA-F]{64}$/.test(header)) return false;
  const given = Buffer.from(header.slice(7).toLowerCase(), 'hex');
  const candidates = [
    hmacHex(raw, appSecret),
    hmacHex(escapeNonAscii(raw.toString('utf8')), appSecret),
  ];
  let ok = false;
  for (const hex of candidates) ok = timingSafeEqual(Buffer.from(hex, 'hex'), given) || ok;
  return ok;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** `signed_request` as Meta sends it to the deauthorize and data-deletion callbacks: base64url(signature).base64url(payload). */
export function parseSignedRequest(
  signedRequest: string,
  appSecret: string,
): Record<string, unknown> | null {
  const parts = signedRequest.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [sig, payload] = parts as [string, string];
  const expected = createHmac('sha256', appSecret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const algorithm = (data as { algorithm?: unknown }).algorithm;
    if (typeof algorithm === 'string' && algorithm.toUpperCase() !== 'HMAC-SHA256') return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Build a signed_request (tests, docs, the local helper). */
export function buildSignedRequest(payload: Record<string, unknown>, appSecret: string): string {
  const body = b64u(JSON.stringify({ algorithm: 'HMAC-SHA256', ...payload }));
  return `${b64u(createHmac('sha256', appSecret).update(body).digest())}.${body}`;
}

// ---- OAuth state: signed, bound to user + business, expiring --------------------------------------------------------------

export interface OauthState {
  /** Business, person and a random value: replaying or moving the state to another session cannot work. */
  t: string;
  u: string;
  n: string;
  /** Expiry, epoch ms. */
  exp: number;
}

export function signState(state: OauthState, appSecret: string): string {
  const body = b64u(JSON.stringify(state));
  return `${body}.${b64u(createHmac('sha256', appSecret).update(`oauth-state.${body}`).digest())}`;
}

/** The state if its signature is ours and it has not expired, else null. */
export function verifyState(value: string, appSecret: string, now: number): OauthState | null {
  const [body, sig] = value.split('.');
  if (!body || !sig || value.split('.').length !== 2) return null;
  const expected = createHmac('sha256', appSecret).update(`oauth-state.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OauthState;
    if (
      typeof s.t !== 'string' ||
      typeof s.u !== 'string' ||
      typeof s.n !== 'string' ||
      typeof s.exp !== 'number' ||
      s.exp <= now
    )
      return null;
    return s;
  } catch {
    return null;
  }
}

/** What is stored instead of the state: the state itself never touches the database. */
export const hashState = (state: string) => createHash('sha256').update(state).digest('hex');

/** A stable code for a deletion request, so the status URL needs no table. */
export function deletionCode(subject: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(`deletion.${subject}`).digest('hex').slice(0, 24);
}
