import { describe, expect, it, vi } from 'vitest';
import { emailContent } from './deliver.js';
import {
  ConsoleMessagingProvider,
  DevPushProvider,
  EXPO_BATCH,
  ExpoPushProvider,
  buildProviders,
  channelAvailability,
  maskPhone,
  tokenFingerprint,
} from './providers/index.js';

const message = (n: number) => ({
  token: `ExponentPushToken[token-${n}]`,
  platform: 'android' as const,
  title: 'Low stock alert',
  body: 'Open OrderLoop to see the details.',
  data: { kind: 'LOW_STOCK', id: 'n1' },
});

describe('DevPushProvider', () => {
  it('records the push as sent, logs a redacted line and writes the outbox without the full token', async () => {
    const log = vi.fn();
    const append = vi.fn().mockResolvedValue(undefined);
    const dev = new DevPushProvider({ log, outboxPath: '/tmp/outbox.jsonl', append });
    const out = await dev.send([message(1), message(2)]);
    expect(out.map((o) => o.status)).toEqual(['ok', 'ok']);
    expect(append).toHaveBeenCalledTimes(2);
    const line = JSON.parse(append.mock.calls[0]![1] as string) as Record<string, unknown>;
    expect(line).toMatchObject({
      device: tokenFingerprint(message(1).token),
      platform: 'android',
      data: { kind: 'LOW_STOCK', id: 'n1' },
    });
    expect(JSON.stringify([log.mock.calls, append.mock.calls])).not.toContain('token-1');
  });
  it('without an outbox it only logs', async () => {
    const append = vi.fn();
    await new DevPushProvider({ log: vi.fn(), append }).send([message(1)]);
    expect(append).not.toHaveBeenCalled();
  });
});

describe('ExpoPushProvider', () => {
  const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });

  it('posts batches of 100 with the optional access token and maps each ticket to its device', async () => {
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as unknown[];
      return ok(
        sent.map((_, i) =>
          i === 0 ? { status: 'ok', id: `t${i}` } : { status: 'ok', id: `t${i}` },
        ),
      );
    });
    const expo = new ExpoPushProvider({ accessToken: 'secret-access', fetch: fetch as never });
    const messages = Array.from({ length: EXPO_BATCH + 20 }, (_, i) => message(i));
    const out = await expo.send(messages);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toHaveLength(100);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toHaveLength(20);
    expect(
      (fetch.mock.calls[0]![1] as unknown as { headers: Record<string, string> }).headers
        .authorization,
    ).toBe('Bearer secret-access');
    expect(out).toHaveLength(120);
    expect(out[0]).toMatchObject({ status: 'ok', ticketId: 't0' });
  });

  it('DeviceNotRegistered marks the device gone; a rate limit is transient; other errors are final', async () => {
    const fetch = vi.fn(async () =>
      ok([
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', details: { error: 'MessageRateExceeded' } },
        { status: 'error', details: { error: 'MessageTooBig' } },
      ]),
    );
    const out = await new ExpoPushProvider({ fetch: fetch as never }).send([
      message(1),
      message(2),
      message(3),
    ]);
    expect(out[0]).toMatchObject({ status: 'error', deviceGone: true });
    expect(out[1]).toMatchObject({ status: 'error', deviceGone: false, permanent: false });
    expect(out[2]).toMatchObject({ status: 'error', deviceGone: false, permanent: true });
  });

  it('a whole-request failure is classified by its HTTP status', async () => {
    const down = new ExpoPushProvider({
      fetch: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as never,
    });
    await expect(down.send([message(1)])).rejects.toMatchObject({ permanent: false });
    const bad = new ExpoPushProvider({
      fetch: (async () => ({ ok: false, status: 400, json: async () => ({}) })) as never,
    });
    await expect(bad.send([message(1)])).rejects.toMatchObject({ permanent: true });
  });

  it('passes a timeout signal and reads receipts', async () => {
    const fetch = vi.fn(async (_u: string, init: { signal: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            t1: { status: 'ok' },
            t2: { status: 'error', details: { error: 'DeviceNotRegistered' } },
          },
        }),
      };
    });
    const r = await new ExpoPushProvider({ fetch: fetch as never }).receipts(['t1', 't2']);
    expect(r).toEqual({
      t1: { ok: true, error: undefined },
      t2: { ok: false, error: 'DeviceNotRegistered' },
    });
  });
});

describe('ConsoleMessagingProvider', () => {
  it('logs a masked number and the message length, not the message', async () => {
    const log = vi.fn();
    const sink = vi.fn();
    const p = new ConsoleMessagingProvider({ log, sink });
    const res = await p.send({
      channel: 'sms',
      to: '+8801712345678',
      body: 'secret words',
      idempotencyKey: 'd1',
    });
    expect(res.providerRef).toBe('console:d1');
    expect(sink).toHaveBeenCalled();
    const text = JSON.stringify(log.mock.calls);
    expect(text).not.toContain('01712345678');
    expect(text).not.toContain('secret words');
    expect(maskPhone('+8801712345678')).toBe('+88017******78');
  });
});

describe('buildProviders', () => {
  const base = {
    nodeEnv: 'development' as const,
    pushProvider: 'dev' as const,
    smsProvider: 'none' as const,
    whatsappProvider: 'none' as const,
  };
  it('sms and whatsapp are unavailable when none, available when console; there is no vendor', () => {
    expect(channelAvailability({ smsProvider: 'none', whatsappProvider: 'console' })).toEqual({
      sms: false,
      whatsapp: true,
    });
    const p = buildProviders({ ...base, smsProvider: 'console' }, null, vi.fn());
    expect(p.sms?.name).toBe('console');
    expect(p.whatsapp).toBeNull();
    expect(Object.keys(p.push)).toEqual(['dev']);
  });
  it('selects expo when asked', () => {
    expect(
      Object.keys(buildProviders({ ...base, pushProvider: 'expo' }, null, vi.fn()).push),
    ).toEqual(['expo']);
  });
  it('warns loudly when the dev push provider or a console messaging provider runs in production', () => {
    const log = vi.fn();
    buildProviders({ ...base, nodeEnv: 'production', smsProvider: 'console' }, null, log);
    const events = log.mock.calls.map((c) => c[0].event);
    expect(events).toContain('push.dev_provider_in_production');
    expect(events).toContain('messaging.console_provider_in_production');
    const quiet = vi.fn();
    buildProviders({ ...base, nodeEnv: 'production', pushProvider: 'expo' }, null, quiet);
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe('emailContent', () => {
  it('uses the notification wording and escapes it', () => {
    const c = emailContent({ title: 'Low stock: 2 items', body: 'Tee <b>(TEE-1)</b> & mug' });
    expect(c.subject).toBe('Low stock: 2 items');
    expect(c.html).toContain('&#60;b&#62;');
    expect(c.html).not.toContain('<b>');
    expect(c.text).toContain('Tee <b>(TEE-1)</b> & mug');
  });
});
