import { createHash, timingSafeEqual } from 'node:crypto';
import { takaToMinor } from './money.js';
import { mapPathaoStatus, mapSteadfastStatus } from './status.js';
import type { CourierEvent } from './types.js';

/** Compare secrets without leaking, through timing, how much of one matched. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

const header = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
const digest = (...parts: (string | undefined)[]) =>
  createHash('sha256')
    .update(parts.map((p) => p ?? '').join('␟'))
    .digest('hex')
    .slice(0, 40);

export type ParsedWebhook =
  | { kind: 'event'; event: CourierEvent }
  | { kind: 'handshake' }
  /** A well-formed event that says nothing we act on (a payment note, a store change). */
  | { kind: 'ignored'; reason: string }
  | { kind: 'invalid'; reason: string };

// ---- Pathao ---------------------------------------------------------------------------------------------------------

/**
 * Pathao's webhook carries the merchant's webhook secret, as is, in `X-Pathao-Signature` (it is not an HMAC). The endpoint
 * must answer 2xx within 10 seconds with `X-Pathao-Merchant-Webhook-Integration-Secret` set to Pathao's published
 * integration value. Source: Pathao's own open-source WooCommerce plugin (github.com/pathao-eng/courier-woocommerce-plugin).
 */
export const PATHAO_SIGNATURE_HEADER = 'x-pathao-signature';
export const PATHAO_INTEGRATION_HEADER = 'X-Pathao-Merchant-Webhook-Integration-Secret';
/** A public protocol constant published by Pathao for every merchant; it identifies the integration, it authenticates nothing. */
export const PATHAO_INTEGRATION_VALUE = 'f3992ecc-59da-4cbe-a049-a13da2018d51';

export function verifyPathaoWebhook(
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  const got = header(headers, PATHAO_SIGNATURE_HEADER);
  return !!got && !!secret && safeEqual(got, secret);
}

export function parsePathaoWebhook(body: unknown): ParsedWebhook {
  if (!body || typeof body !== 'object')
    return { kind: 'invalid', reason: 'The body is not a JSON object' };
  const b = body as Record<string, unknown>;
  const event = text(b['event']);
  if (event === 'webhook_integration') return { kind: 'handshake' };
  const consignmentId = text(b['consignment_id']);
  const providerStatus = text(b['order_status']) ?? event;
  if (!providerStatus) return { kind: 'invalid', reason: 'The event names no status' };
  if (!consignmentId && !text(b['merchant_order_id'])) {
    if (event?.startsWith('store.')) return { kind: 'ignored', reason: 'A store event' };
    return { kind: 'invalid', reason: 'The event names no parcel' };
  }
  // The event name is the more reliable signal (order_status is display text), so it wins when it maps.
  const fromEvent = event ? mapPathaoStatus(event) : undefined;
  const status = fromEvent && fromEvent !== 'unknown' ? fromEvent : mapPathaoStatus(providerStatus);
  const occurredAt = text(b['updated_at']) ?? text(b['timestamp']);
  const fee = takaToMinor(b['delivery_fee']);
  return {
    kind: 'event',
    event: {
      eventKey: digest(
        'pathao',
        consignmentId ?? text(b['merchant_order_id']),
        event,
        providerStatus,
        occurredAt,
      ),
      consignmentId: consignmentId ?? null,
      reference: text(b['merchant_order_id']) ?? null,
      providerStatus:
        event && providerStatus !== event ? `${providerStatus} (${event})` : providerStatus,
      status,
      occurredAt,
      ...(fee !== undefined ? { deliveryFeeMinor: fee } : {}),
      raw: body,
    },
  };
}

// ---- Steadfast ------------------------------------------------------------------------------------------------------

/**
 * Steadfast calls the callback URL set in the merchant panel with `Authorization: Bearer <the Auth token you chose>`. A wrong
 * token must be answered 401; a payload missing required fields 400; success 200 with `{ "status": "success" }`.
 * Source: the Steadfast Courier Laravel package published by the company (github.com/steadfast-it).
 */
export function verifySteadfastWebhook(
  headers: Record<string, string | string[] | undefined>,
  token: string,
): boolean {
  const got = header(headers, 'authorization');
  return !!got && !!token && safeEqual(got, `Bearer ${token}`);
}

export function parseSteadfastWebhook(
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
): ParsedWebhook {
  if (!body || typeof body !== 'object')
    return { kind: 'invalid', reason: 'The body is not a JSON object' };
  const b = body as Record<string, unknown>;
  const type = text(b['notification_type']) ?? 'delivery_status';
  const consignmentId = text(b['consignment_id']);
  const invoice = text(b['invoice']);
  const occurredAt = text(b['updated_at']);
  // Steadfast retries an event with the same Idempotency-Key; without one, the content identifies it.
  const idem = header(headers, 'idempotency-key');
  if (type === 'delivery_status') {
    const status = text(b['status']);
    if (!consignmentId || !invoice || !status || b['cod_amount'] === undefined || !occurredAt)
      return {
        kind: 'invalid',
        reason:
          'A delivery_status event needs consignment_id, invoice, status, cod_amount and updated_at',
      };
    const fee = takaToMinor(b['delivery_charge']);
    const cod = takaToMinor(b['cod_amount']);
    return {
      kind: 'event',
      event: {
        eventKey: idem ? `idem:${idem}` : digest('steadfast', consignmentId, status, occurredAt),
        consignmentId,
        reference: invoice,
        providerStatus: status,
        status: mapSteadfastStatus(status),
        message: text(b['tracking_message']),
        occurredAt,
        ...(fee !== undefined ? { deliveryFeeMinor: fee } : {}),
        ...(cod !== undefined ? { codAmountMinor: cod } : {}),
        raw: body,
      },
    };
  }
  if (type === 'tracking_update') {
    const message = text(b['tracking_message']);
    if (!consignmentId || !message || !occurredAt)
      return {
        kind: 'invalid',
        reason: 'A tracking_update event needs consignment_id, tracking_message and updated_at',
      };
    return {
      kind: 'event',
      event: {
        eventKey: idem
          ? `idem:${idem}`
          : digest('steadfast', consignmentId, 'tracking', message, occurredAt),
        consignmentId,
        reference: invoice ?? null,
        providerStatus: 'tracking_update',
        status: null,
        message,
        occurredAt,
        raw: body,
      },
    };
  }
  return { kind: 'ignored', reason: `A ${type} notification, which we do not act on` };
}
