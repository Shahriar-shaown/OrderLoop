import { ApiError } from '@orderloop/api-client';
import { translate } from '@orderloop/ui';
import { describe, expect, it } from 'vitest';
import '../i18n';
import { messageFor, tiktokErrorText } from '../forms/errors';
import {
  CONNECTION_STATUS,
  humanize,
  nextStatus,
  OAUTH_ERRORS,
  oauthErrorMessage,
  orderStatus,
  STOCK_STATE,
  stockState,
} from './tiktok';

describe('order and stock wording', () => {
  it('has wording for every status TikTok documents, and shows any other as it came', () => {
    for (const status of [
      'UNPAID',
      'ON_HOLD',
      'AWAITING_SHIPMENT',
      'PARTIALLY_SHIPPING',
      'AWAITING_COLLECTION',
      'IN_TRANSIT',
      'DELIVERED',
      'COMPLETED',
      'CANCELLED',
    ])
      expect(orderStatus(status).label, status).not.toMatch(/_/);
    expect(orderStatus('SOMETHING_NEW')).toEqual({ label: 'Something new', tone: 'neutral' });
    expect(humanize('')).toBe('Unknown');
  });

  it('has wording for every stock state, and tolerates an unknown one', () => {
    for (const key of Object.keys(STOCK_STATE)) expect(stockState(key).label).toBeTruthy();
    expect(stockState('later').label).toBe('Later');
    expect(stockState('later').tone).toBe('neutral');
  });

  it('knows where a status goes next, and where it cannot go', () => {
    expect(nextStatus('AWAITING_SHIPMENT')).toBe('IN_TRANSIT');
    expect(nextStatus('IN_TRANSIT')).toBe('DELIVERED');
    expect(nextStatus('COMPLETED')).toBeNull();
    expect(nextStatus('CANCELLED')).toBeNull();
    expect(nextStatus('SOMETHING_NEW')).toBeNull();
  });

  it('explains every connection status', () => {
    for (const s of Object.values(CONNECTION_STATUS))
      expect(s.explanation.length).toBeGreaterThan(20);
  });
});

describe('errors', () => {
  it('has a message for every sign-in error code', () => {
    for (const code of Object.keys(OAUTH_ERRORS))
      expect(oauthErrorMessage(code), code).toBe(OAUTH_ERRORS[code]);
    expect(oauthErrorMessage('???')).toMatch(/did not finish/);
  });

  it('words the API error codes for people', () => {
    for (const code of [
      'tiktok_not_configured',
      'tiktok_oauth_invalid',
      'tiktok_permission_denied',
      'tiktok_token_invalid',
      'tiktok_unavailable',
    ]) {
      const text = messageFor(new ApiError('raw server words', 409, code));
      expect(text, code).toBe(tiktokErrorText(code));
      expect(text).not.toContain('raw server words');
    }
    expect(tiktokErrorText('conflict')).toMatch(/another business/);
    expect(tiktokErrorText('nope', 'It said so')).toBe('It said so');
    expect(tiktokErrorText('nope')).toMatch(/could not be connected/);
  });

  it('words the refusal of a hand release or fulfil (409) and a hand-made order reservation (400)', () => {
    expect(
      messageFor(
        new ApiError(
          'This reservation belongs to an order. Change the order instead of releasing or fulfilling it here.',
          409,
          'conflict',
        ),
      ),
    ).toMatch(/belongs to an order/);
    expect(messageFor(new ApiError('Reservation is already RELEASED', 409, 'conflict'))).toBe(
      'Reservation is already RELEASED',
    );
    expect(
      messageFor(
        new ApiError('Request validation failed', 400, 'validation_failed', [
          {
            path: 'body.referenceType',
            message: 'Reservations for orders are created by the order itself',
          },
        ]),
      ),
    ).toMatch(/created by the order itself/);
  });
});

describe('Bangla', () => {
  const bn = (text: string) => translate('bn', text);
  it('translates the statuses, stock states and the sentences that explain them', () => {
    for (const text of [
      ...Object.values(STOCK_STATE).flatMap((s) => [s.label, s.hint]),
      ...Object.values(CONNECTION_STATUS).flatMap((s) => [s.label, s.explanation]),
      ...Object.values(OAUTH_ERRORS),
      orderStatus('IN_TRANSIT').label,
      orderStatus('AWAITING_SHIPMENT').label,
      'Waiting for you to map 1 item: no stock has been moved.',
      'Waiting for you to map 3 items: no stock has been moved.',
    ])
      expect(bn(text), text).not.toBe(text);
  });
});
