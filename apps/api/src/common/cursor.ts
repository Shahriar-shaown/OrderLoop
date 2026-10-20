import { UUID_RE } from './uuid.js';

/** Keyset pagination cursor over (createdAt, id): opaque to clients, stable under concurrent inserts. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | undefined {
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t: string;
      id: string;
    };
    const createdAt = new Date(t);
    if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(id)) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

/** Cursor over a composite id (variantId, locationId), for the stock list which is ordered by its primary key. */
export function encodePairCursor(a: string, b: string): string {
  return Buffer.from(JSON.stringify({ a, b })).toString('base64url');
}

export function decodePairCursor(cursor: string): { a: string; b: string } | undefined {
  try {
    const { a, b } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      a: string;
      b: string;
    };

    return UUID_RE.test(a) && UUID_RE.test(b) ? { a, b } : undefined;
  } catch {
    return undefined;
  }
}

/** Cursor over the ledger sequence number. */
export function encodeSeqCursor(seq: bigint): string {
  return Buffer.from(JSON.stringify({ s: seq.toString() })).toString('base64url');
}

export function decodeSeqCursor(cursor: string): bigint | undefined {
  try {
    const { s } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s: string };
    return /^\d{1,18}$/.test(s) ? BigInt(s) : undefined;
  } catch {
    return undefined;
  }
}
