import { ApiError } from '@orderloop/api-client';
import { LoginBody } from '@orderloop/contracts';
import { describe, expect, it } from 'vitest';
import { fieldErrorsFrom, messageFor, safeNext, validate } from './errors';

describe('messageFor', () => {
  it('gives people-friendly text for known codes', () => {
    expect(messageFor(new ApiError('x', 401, 'invalid_credentials'))).toBe(
      'Incorrect email or password.',
    );
    expect(messageFor(new ApiError('x', 0, 'network_error'))).toMatch(/Cannot reach the server/);
    expect(messageFor(new ApiError('x', 400, 'token_invalid'))).toMatch(/invalid or has expired/);
    expect(messageFor(new ApiError('x', 403, 'forbidden'))).toMatch(/permission/);
  });

  it('passes through the API message for conflicts and stock problems', () => {
    expect(
      messageFor(new ApiError('Only 3 available, 5 requested', 409, 'insufficient_stock')),
    ).toBe('Only 3 available, 5 requested');
    expect(messageFor(new ApiError('SKU already exists', 409, 'conflict'))).toBe(
      'SKU already exists',
    );
  });

  it('points at the fields for validation failures', () => {
    expect(
      messageFor(
        new ApiError('bad', 422, 'validation_failed', [{ path: 'body.email', message: 'no' }]),
      ),
    ).toBe('Please fix the highlighted fields.');
  });

  it('never shows server internals for a 5xx or an unknown error', () => {
    expect(messageFor(new ApiError('stack trace here', 500, 'internal'))).toBe(
      'Something went wrong on our side. Try again in a moment.',
    );
    expect(messageFor(new Error('secret'))).toBe('Something went wrong. Try again.');
    expect(messageFor('weird')).toBe('Something went wrong. Try again.');
  });
});

describe('fieldErrorsFrom', () => {
  it('keys errors by field path without the request part, keeping the first message per field', () => {
    const error = new ApiError('bad', 422, 'validation_failed', [
      { path: 'body.variants.0.sku', message: 'first' },
      { path: 'body.variants.0.sku', message: 'second' },
      { path: 'query.limit', message: 'too big' },
    ]);
    expect(fieldErrorsFrom(error)).toEqual({ 'variants.0.sku': 'first', limit: 'too big' });
  });

  it('is empty for anything else', () => {
    expect(fieldErrorsFrom(new Error('x'))).toEqual({});
    expect(fieldErrorsFrom(new ApiError('x', 500))).toEqual({});
  });
});

describe('validate', () => {
  it('returns parsed data when the schema accepts the values', () => {
    const result = validate(LoginBody, { email: 'a@b.co', password: 'a-long-enough-password' });
    expect(result.errors).toBeNull();
    expect(result.data).toMatchObject({ email: 'a@b.co' });
  });

  it('returns errors keyed by field path, using the same rules as the API', () => {
    const result = validate(LoginBody, { email: 'nope', password: '' });
    expect(result.data).toBeNull();
    expect(Object.keys(result.errors ?? {}).sort()).toEqual(['email', 'password']);
  });
});

describe('safeNext (open-redirect guard)', () => {
  it('allows same-site paths', () => {
    expect(safeNext('/inventory')).toBe('/inventory');
    expect(safeNext('/products/123?tab=x')).toBe('/products/123?tab=x');
  });

  it('refuses anything that could leave the site, or is missing', () => {
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      'products',
      '/a\nb',
      '',
      null,
      undefined,
    ]) {
      expect(safeNext(bad)).toBe('/products');
    }
    expect(safeNext('//evil.example', '/home')).toBe('/home');
  });
});
