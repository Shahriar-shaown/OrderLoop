import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSignedRequest,
  deletionCode,
  escapeNonAscii,
  hashState,
  hubSignature,
  parseSignedRequest,
  safeEqual,
  signState,
  verifyHubSignature,
  verifyState,
} from './signature.js';

const SECRET = 'a-sixteen-char-app-secret';
const body = (obj: unknown) => Buffer.from(JSON.stringify(obj));

describe('X-Hub-Signature-256', () => {
  const payload = body({
    object: 'page',
    entry: [{ id: '1', messaging: [{ message: { text: 'hello' } }] }],
  });

  it('accepts the signature of the raw bytes', () => {
    expect(verifyHubSignature(payload, hubSignature(payload, SECRET), SECRET)).toBe(true);
  });
  it('accepts hex in upper case', () => {
    const sig = hubSignature(payload, SECRET);
    expect(verifyHubSignature(payload, `sha256=${sig.slice(7).toUpperCase()}`, SECRET)).toBe(true);
  });
  it('accepts a signature over the escaped \\uXXXX form of a payload with non-ASCII text (as Meta documents)', () => {
    const bangla = body({
      object: 'page',
      entry: [{ messaging: [{ message: { text: 'আমি ২টা নিব äöå 😀' } }] }],
    });
    expect(bangla.toString('utf8')).toContain('আমি'); // the raw bytes are NOT escaped
    const escaped = hubSignature(bangla, SECRET, true);
    expect(escaped).not.toBe(hubSignature(bangla, SECRET));
    expect(verifyHubSignature(bangla, escaped, SECRET)).toBe(true);
    expect(verifyHubSignature(bangla, hubSignature(bangla, SECRET), SECRET)).toBe(true);
  });
  it('escapes like the documentation: lowercase hex, one escape per UTF-16 unit', () => {
    expect(escapeNonAscii('äöå')).toBe('\\u00e4\\u00f6\\u00e5');
    expect(escapeNonAscii('😀')).toBe('\\ud83d\\ude00');
    expect(escapeNonAscii('plain "ascii" \\ / {}')).toBe('plain "ascii" \\ / {}');
  });
  it('rejects a wrong secret, a changed body, and the signature of another body', () => {
    const sig = hubSignature(payload, SECRET);
    expect(verifyHubSignature(payload, sig, 'another-sixteen-char-secret')).toBe(false);
    expect(verifyHubSignature(Buffer.concat([payload, Buffer.from(' ')]), sig, SECRET)).toBe(false);
    expect(verifyHubSignature(body({ other: 1 }), sig, SECRET)).toBe(false);
  });
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['no prefix', 'a'.repeat(64)],
    ['sha1 prefix', `sha1=${'a'.repeat(40)}`],
    ['too short', 'sha256=abcd'],
    ['not hex', `sha256=${'z'.repeat(64)}`],
    ['array', ['sha256=' + 'a'.repeat(64)]],
  ])('rejects a %s header without throwing', (_name, header) => {
    expect(verifyHubSignature(payload, header as never, SECRET)).toBe(false);
  });
  it('compares in constant time whatever the lengths (no throw on unequal inputs)', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('signed_request (deauthorize and data deletion)', () => {
  it('round-trips and returns the payload', () => {
    const sr = buildSignedRequest({ user_id: '12345', issued_at: 1 }, SECRET);
    expect(parseSignedRequest(sr, SECRET)).toMatchObject({
      user_id: '12345',
      algorithm: 'HMAC-SHA256',
    });
  });
  it('rejects a wrong secret, a tampered payload, and malformed input', () => {
    const sr = buildSignedRequest({ user_id: '12345' }, SECRET);
    expect(parseSignedRequest(sr, 'another-sixteen-char-secret')).toBeNull();
    const [sig, payload] = sr.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '999' }),
    ).toString('base64url');
    expect(parseSignedRequest(`${sig}.${forged}`, SECRET)).toBeNull();
    for (const bad of ['', 'x', 'a.b.c', `.${payload}`, `${sig}.`, 'only-one-part'])
      expect(parseSignedRequest(bad, SECRET)).toBeNull();
  });
  it('rejects another algorithm', () => {
    const sr = buildSignedRequest({ algorithm: 'HMAC-SHA1', user_id: '1' }, SECRET);
    expect(parseSignedRequest(sr, SECRET)).toBeNull();
  });
  it('rejects a payload that is not an object', () => {
    const payload = Buffer.from('[1,2]').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payload).digest().toString('base64url');
    expect(parseSignedRequest(`${sig}.${payload}`, SECRET)).toBeNull();
  });
  it('makes a stable deletion code per subject', () => {
    expect(deletionCode('1', SECRET)).toBe(deletionCode('1', SECRET));
    expect(deletionCode('1', SECRET)).not.toBe(deletionCode('2', SECRET));
    expect(deletionCode('1', SECRET)).toHaveLength(24);
  });
});

describe('OAuth state', () => {
  const now = 1_000_000;
  const state = { t: 'tenant', u: 'user', n: 'nonce', exp: now + 600_000 };
  it('round-trips while it is fresh', () => {
    expect(verifyState(signState(state, SECRET), SECRET, now)).toEqual(state);
  });
  it('expires', () => {
    expect(verifyState(signState(state, SECRET), SECRET, now + 600_000)).toBeNull();
  });
  it('rejects tampering, another secret and junk', () => {
    const s = signState(state, SECRET);
    const [body] = s.split('.') as [string];
    const forged = Buffer.from(JSON.stringify({ ...state, u: 'someone-else' })).toString(
      'base64url',
    );
    expect(verifyState(`${forged}.${s.split('.')[1]}`, SECRET, now)).toBeNull();
    expect(verifyState(s, 'another-sixteen-char-secret', now)).toBeNull();
    for (const bad of ['', 'x', `${body}.`, `.${s.split('.')[1]}`, `${s}.extra`])
      expect(verifyState(bad, SECRET, now)).toBeNull();
  });
  it('is stored only as a hash', () => {
    const s = signState(state, SECRET);
    expect(hashState(s)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashState(s)).not.toContain(s.slice(0, 10));
  });
});
