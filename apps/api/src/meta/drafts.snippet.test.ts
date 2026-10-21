import { describe, expect, it } from 'vitest';
import { snippetOf } from './drafts.service.js';

const ev = (id: string, at: number, payload: unknown) => ({
  id,
  eventTimestamp: new Date(at),
  payload,
});

describe('snippetOf', () => {
  it('is the first 60 characters of the earliest message with text', () => {
    const long = 'x'.repeat(100);
    expect(snippetOf([ev('b', 2, { text: 'later' }), ev('a', 1, { text: long })])).toBe(
      'x'.repeat(60),
    );
  });
  it('skips attachment-only messages and is null when no message has text', () => {
    expect(
      snippetOf([ev('a', 1, { attachments: [{ type: 'image' }] }), ev('b', 2, { text: 'hi' })]),
    ).toBe('hi');
    expect(snippetOf([ev('a', 1, { attachments: [{ type: 'image' }] })])).toBeNull();
    expect(snippetOf([])).toBeNull();
  });
  it('never cuts a character in half', () => {
    const s = snippetOf([ev('a', 1, { text: '😀'.repeat(70) })])!;
    expect(Array.from(s)).toHaveLength(60);
  });
});
