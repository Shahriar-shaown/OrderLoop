import { describe, expect, it } from 'vitest';
import { parseWebhook } from './parse.js';

const page = (messaging: unknown[], id = 'PAGE1') => ({
  object: 'page',
  entry: [{ id, time: 1_700_000_000_000, messaging }],
});

describe('parseWebhook', () => {
  it('reads a Page text message', () => {
    const r = parseWebhook(
      page([
        {
          sender: { id: 'PSID1' },
          recipient: { id: 'PAGE1' },
          timestamp: 1_700_000_001_000,
          message: { mid: 'm_1', text: 'আমি অর্ডার করতে চাই' },
        },
      ]),
    );
    expect(r.object).toBe('page');
    expect(r.events).toEqual([
      {
        provider: 'facebook_page',
        accountId: 'PAGE1',
        senderId: 'PSID1',
        eventType: 'message',
        key: 'm_1',
        timestamp: new Date(1_700_000_001_000),
        text: 'আমি অর্ডার করতে চাই',
        attachmentTypes: [],
      },
    ]);
  });
  it('reads an Instagram message and keeps only the kind of each attachment', () => {
    const r = parseWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'IG1',
          time: 1,
          messaging: [
            {
              sender: { id: 'IGSID' },
              recipient: { id: 'IG1' },
              timestamp: 5,
              message: {
                mid: 'ig_1',
                attachments: [
                  { type: 'image', payload: { url: 'https://cdn.example/secret.jpg' } },
                  { type: 'audio', payload: {} },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(r.events[0]).toMatchObject({
      provider: 'instagram',
      accountId: 'IG1',
      text: null,
      attachmentTypes: ['image', 'audio'],
    });
    expect(JSON.stringify(r)).not.toContain('cdn.example');
  });
  it('records an echo against the customer and never reads its text', () => {
    const r = parseWebhook(
      page([
        {
          sender: { id: 'PAGE1' },
          recipient: { id: 'PSID1' },
          timestamp: 1,
          message: { mid: 'm_e', is_echo: true, text: 'Thanks, we will ship tomorrow' },
        },
      ]),
    );
    expect(r.events[0]).toMatchObject({ eventType: 'echo', senderId: 'PSID1', text: null });
    expect(JSON.stringify(r)).not.toContain('ship tomorrow');
  });
  it('records edits and postbacks without their content', () => {
    const r = parseWebhook(
      page([
        {
          sender: { id: 'S' },
          recipient: { id: 'PAGE1' },
          timestamp: 1,
          message_edit: { mid: 'm_1', num_edit: 1, text: 'edited' },
        },
        {
          sender: { id: 'S' },
          recipient: { id: 'PAGE1' },
          timestamp: 2,
          postback: { title: 'Get started', payload: 'X' },
        },
      ]),
    );
    expect(
      r.events.map((e) => [
        e.eventType,
        e.key.startsWith('edit:m_1:1') || e.key.startsWith('postback:'),
      ]),
    ).toEqual([
      ['edit', true],
      ['postback', true],
    ]);
    expect(r.events.every((e) => e.text === null)).toBe(true);
  });
  it('skips deliveries, reads and reactions, and anything malformed, without throwing', () => {
    const r = parseWebhook(
      page([
        {
          sender: { id: 'S' },
          recipient: { id: 'PAGE1' },
          timestamp: 1,
          delivery: { mids: ['m'] },
        },
        { sender: { id: 'S' }, recipient: { id: 'PAGE1' }, timestamp: 1, read: { watermark: 1 } },
        { sender: { id: 'S' }, recipient: { id: 'PAGE1' }, timestamp: 1, reaction: { emoji: 'x' } },
        'junk',
        null,
        7,
        { message: { text: 'no ids' } },
      ]),
    );
    expect(r.events).toEqual([]);
    expect(r.skipped).toBe(7);
  });
  it.each([
    null,
    undefined,
    'x',
    5,
    [],
    {},
    { object: 'user' },
    { object: 'page' },
    { object: 'page', entry: 'x' },
    { object: 'page', entry: [null, {}] },
  ])('returns nothing for %j', (body) => {
    expect(parseWebhook(body).events).toEqual([]);
  });
  it('is unaffected by event order inside the notification: each event carries its own timestamp', () => {
    const r = parseWebhook(
      page([
        {
          sender: { id: 'S' },
          recipient: { id: 'PAGE1' },
          timestamp: 2000,
          message: { mid: 'b', text: 'second' },
        },
        {
          sender: { id: 'S' },
          recipient: { id: 'PAGE1' },
          timestamp: 1000,
          message: { mid: 'a', text: 'first' },
        },
      ]),
    );
    expect(r.events.map((e) => [e.key, e.timestamp.getTime()])).toEqual([
      ['b', 2000],
      ['a', 1000],
    ]);
  });
  it('caps very long text', () => {
    const r = parseWebhook(
      page([
        {
          sender: { id: 'S' },
          recipient: { id: 'PAGE1' },
          timestamp: 1,
          message: { mid: 'l', text: 'x'.repeat(10_000) },
        },
      ]),
    );
    expect(r.events[0]!.text).toHaveLength(2000);
  });
});
