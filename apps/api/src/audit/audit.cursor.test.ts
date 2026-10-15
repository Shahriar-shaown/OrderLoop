import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './audit.service.js';

describe('audit cursor', () => {
  it('round-trips', () => {
    const at = new Date('2026-10-15T12:00:00.123Z');
    const id = '0197b0a0-0000-7000-8000-000000000001';
    expect(decodeCursor(encodeCursor(at, id))).toEqual({ createdAt: at, id });
  });
  it('rejects garbage rather than throwing', () => {
    expect(decodeCursor('###')).toBeUndefined();
    expect(
      decodeCursor(Buffer.from('{"t":"nope","id":"x"}').toString('base64url')),
    ).toBeUndefined();
  });
});
