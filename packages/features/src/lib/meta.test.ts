import { ApiError } from '@orderloop/api-client';
import { describe, expect, it } from 'vitest';
import { messageFor, metaErrorText } from '../forms/errors';
import { OAUTH_ERRORS, maskPhone, mockMessageId, warningText } from './meta';

describe('maskPhone', () => {
  it('keeps the operator prefix and the last four digits', () => {
    expect(maskPhone('+8801712345678')).toBe('017••••5678');
    expect(maskPhone('01712345678')).toBe('017••••5678');
  });
  it('says so when there is no number yet, and hides anything too short to mask', () => {
    expect(maskPhone(null)).toBe('No phone yet');
    expect(maskPhone('123')).toBe('••••');
  });
});

describe('mockMessageId', () => {
  it('is the same for the same message and different for any change', () => {
    const base = mockMessageId('c', 's', 'text');
    expect(mockMessageId('c', 's', 'text')).toBe(base);
    expect(mockMessageId('c2', 's', 'text')).not.toBe(base);
    expect(mockMessageId('c', 's2', 'text')).not.toBe(base);
    expect(mockMessageId('c', 's', 'text!')).not.toBe(base);
    expect(base.length).toBeLessThanOrEqual(128);
  });
});

describe('texts', () => {
  it('has a message for every sign-in error code the API sends back', () => {
    for (const code of [
      'access_denied',
      'invalid_state',
      'meta_not_configured',
      'meta_permission_denied',
      'meta_token_invalid',
      'meta_unavailable',
      'rate_limited',
    ])
      expect(OAUTH_ERRORS[code], code).toBeTruthy();
  });

  it('words every warning code, and falls back to the server for a new one', () => {
    for (const code of [
      'no_phone',
      'multiple_phones',
      'no_address',
      'no_items',
      'unmatched_item',
      'low_confidence_item',
      'price_ignored',
      'duplicate_order',
    ])
      expect(warningText(code, 'x'), code).not.toBe('x');
    expect(warningText('brand_new', 'The server says so')).toBe('The server says so');
  });

  it('maps the Meta and draft error codes to something a person can act on', () => {
    for (const code of [
      'draft_closed',
      'meta_not_configured',
      'meta_oauth_invalid',
      'meta_permission_denied',
      'meta_instagram_not_linked',
      'meta_messages_access_off',
      'meta_token_invalid',
      'meta_unavailable',
    ]) {
      const text = messageFor(new ApiError('raw server words', 409, code));
      expect(text, code).not.toBe('raw server words');
      expect(text.length, code).toBeGreaterThan(20);
    }
    expect(metaErrorText('conflict')).toMatch(/another business/);
    expect(metaErrorText('weird', 'from the server')).toBe('from the server');
  });
});
