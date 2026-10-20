import { describe, expect, it } from 'vitest';
import {
  PATHAO_INTEGRATION_HEADER,
  PATHAO_INTEGRATION_VALUE,
  parsePathaoWebhook,
  parseSteadfastWebhook,
  safeEqual,
  verifyPathaoWebhook,
  verifySteadfastWebhook,
} from './webhook.js';

describe('safeEqual', () => {
  it('compares equal and different secrets, of any length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('Pathao webhook', () => {
  it('authenticates with the secret in X-Pathao-Signature, and nothing else', () => {
    expect(verifyPathaoWebhook({ 'x-pathao-signature': 'my-secret' }, 'my-secret')).toBe(true);
    expect(verifyPathaoWebhook({ 'x-pathao-signature': 'wrong' }, 'my-secret')).toBe(false);
    expect(verifyPathaoWebhook({}, 'my-secret')).toBe(false);
    expect(verifyPathaoWebhook({ 'x-pathao-signature': '' }, '')).toBe(false); // an unset secret authenticates nobody
    expect(verifyPathaoWebhook({ authorization: 'Bearer my-secret' }, 'my-secret')).toBe(false);
    // Pathao's own fixed integration value is not the merchant's secret and must not authenticate
    expect(
      verifyPathaoWebhook({ 'x-pathao-signature': PATHAO_INTEGRATION_VALUE }, 'my-secret'),
    ).toBe(false);
    expect(PATHAO_INTEGRATION_HEADER).toBe('X-Pathao-Merchant-Webhook-Integration-Secret');
  });

  it('recognises the handshake', () => {
    expect(parsePathaoWebhook({ event: 'webhook_integration' })).toEqual({ kind: 'handshake' });
  });

  it('turns an order event into ours and keeps Pathao’s own words', () => {
    const r = parsePathaoWebhook({
      event: 'order.delivered',
      consignment_id: 'DL121224VS8TTJ',
      merchant_order_id: 'OL-1001',
      order_status: 'Delivered',
      delivery_fee: '60',
      updated_at: '2026-10-18 10:00:00',
      timestamp: '2026-10-18T04:00:01+00:00',
    });
    expect(r.kind).toBe('event');
    if (r.kind !== 'event') return;
    expect(r.event).toMatchObject({
      consignmentId: 'DL121224VS8TTJ',
      reference: 'OL-1001',
      status: 'delivered',
      providerStatus: 'Delivered (order.delivered)',
      deliveryFeeMinor: 6000,
      occurredAt: '2026-10-18 10:00:00',
    });
    expect((r.event.raw as { event: string }).event).toBe('order.delivered');
  });

  it('gives the same event key to a retry, and a different one to a different event', () => {
    const base = {
      event: 'order.in-transit',
      consignment_id: 'C1',
      order_status: 'In Transit',
      updated_at: 't1',
    };
    const key = (b: object) =>
      (parsePathaoWebhook(b) as { event: { eventKey: string } }).event.eventKey;
    expect(key(base)).toBe(key({ ...base }));
    expect(key(base)).not.toBe(
      key({ ...base, event: 'order.delivered', order_status: 'Delivered' }),
    );
    expect(key(base)).not.toBe(key({ ...base, updated_at: 't2' }));
  });

  it('ignores money and store events, and rejects what is not an event', () => {
    expect(parsePathaoWebhook({ event: 'store.created' })).toMatchObject({ kind: 'ignored' });
    expect(parsePathaoWebhook({ event: 'order.paid', consignment_id: 'C1' })).toMatchObject({
      kind: 'event',
      event: { status: null },
    });
    expect(
      parsePathaoWebhook({ event: 'order.updated', consignment_id: 'C1', order_status: 'Pending' }),
    ).toMatchObject({ kind: 'event', event: { status: null } }); // informational: a status word beside it must not move the parcel
    expect(
      parsePathaoWebhook({ event: 'order.paid', consignment_id: 'C1', order_status: 'Delivered' }),
    ).toMatchObject({ kind: 'event', event: { status: null } });
    expect(parsePathaoWebhook(null)).toMatchObject({ kind: 'invalid' });
    expect(parsePathaoWebhook({})).toMatchObject({ kind: 'invalid' });
    expect(parsePathaoWebhook({ event: 'order.delivered' })).toMatchObject({ kind: 'invalid' }); // names no parcel
  });
});

describe('Steadfast webhook', () => {
  it('authenticates with Authorization: Bearer <token>', () => {
    expect(verifySteadfastWebhook({ authorization: 'Bearer tok' }, 'tok')).toBe(true);
    expect(verifySteadfastWebhook({ authorization: 'Bearer nope' }, 'tok')).toBe(false);
    expect(verifySteadfastWebhook({ authorization: 'tok' }, 'tok')).toBe(false);
    expect(verifySteadfastWebhook({}, 'tok')).toBe(false);
    expect(verifySteadfastWebhook({ authorization: 'Bearer ' }, '')).toBe(false);
  });

  const delivery = {
    consignment_id: 1234567,
    invoice: 'OL-1001',
    status: 'delivered',
    cod_amount: '1200.00',
    delivery_charge: '60',
    updated_at: '2026-10-18 10:00:00',
  };

  it('turns a delivery_status event into ours (a missing notification_type means delivery_status)', () => {
    const r = parseSteadfastWebhook(delivery);
    expect(r.kind).toBe('event');
    if (r.kind !== 'event') return;
    expect(r.event).toMatchObject({
      consignmentId: '1234567',
      reference: 'OL-1001',
      providerStatus: 'delivered',
      status: 'delivered',
      codAmountMinor: 120_000,
      deliveryFeeMinor: 6000,
    });
  });

  it('uses the provider’s Idempotency-Key as the event key when there is one', () => {
    const a = parseSteadfastWebhook(delivery, { 'idempotency-key': 'evt-9' });
    const b = parseSteadfastWebhook({ ...delivery }, { 'idempotency-key': 'evt-9' });
    expect(a).toMatchObject({ event: { eventKey: 'idem:evt-9' } });
    expect(b).toEqual(a);
    const c = parseSteadfastWebhook(delivery) as { event: { eventKey: string } };
    const d = parseSteadfastWebhook({ ...delivery, updated_at: 'later' }) as {
      event: { eventKey: string };
    };
    expect(c.event.eventKey).not.toBe(d.event.eventKey);
  });

  it('requires the documented fields, and says which are missing', () => {
    for (const drop of ['consignment_id', 'invoice', 'status', 'cod_amount', 'updated_at']) {
      const body: Record<string, unknown> = { ...delivery };
      delete body[drop];
      expect(parseSteadfastWebhook(body), drop).toMatchObject({ kind: 'invalid' });
    }
    expect(parseSteadfastWebhook(undefined)).toMatchObject({ kind: 'invalid' });
  });

  it('handles a tracking note as a message with no status, and ignores other notification types', () => {
    const note = parseSteadfastWebhook({
      notification_type: 'tracking_update',
      consignment_id: 5,
      invoice: 'OL-1',
      tracking_message: 'Parcel reached Dhaka hub',
      updated_at: 't',
    });
    expect(note).toMatchObject({
      kind: 'event',
      event: { status: null, message: 'Parcel reached Dhaka hub' },
    });
    expect(parseSteadfastWebhook({ notification_type: 'payment_request' })).toMatchObject({
      kind: 'ignored',
    });
    expect(
      parseSteadfastWebhook({ notification_type: 'tracking_update', consignment_id: 5 }),
    ).toMatchObject({ kind: 'invalid' });
  });

  it('keeps an unrecognised status as unknown rather than guessing', () => {
    const r = parseSteadfastWebhook({ ...delivery, status: 'on_the_moon' });
    expect(r).toMatchObject({
      kind: 'event',
      event: { status: 'unknown', providerStatus: 'on_the_moon' },
    });
  });
});
