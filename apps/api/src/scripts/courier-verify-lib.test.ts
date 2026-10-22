import { CourierError, type CourierAdapter } from '@orderloop/courier-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  formatMatrix,
  parseVerifyArgs,
  readCredentials,
  readOnly,
  redactOutput,
  runVerification,
} from './courier-verify-lib.js';

describe('parseVerifyArgs', () => {
  it('requires a provider and defaults to the sandbox / steadfast host', () => {
    expect(() => parseVerifyArgs([])).toThrow(/--provider/);
    expect(parseVerifyArgs(['--', '--provider', 'pathao'])).toMatchObject({
      provider: 'pathao',
      environment: 'sandbox',
      host: 'steadfast',
    });
    expect(
      parseVerifyArgs([
        '--provider=steadfast',
        '--host',
        'packzy',
        '--reference',
        'OL-1001',
        '--consignment',
        '12345',
      ]),
    ).toMatchObject({
      provider: 'steadfast',
      host: 'packzy',
      reference: 'OL-1001',
      consignment: '12345',
    });
    expect(
      parseVerifyArgs([
        '--provider',
        'pathao',
        '--city-id',
        '1',
        '--zone-id',
        '2',
        '--store-id',
        '3',
      ]),
    ).toMatchObject({ cityId: 1, zoneId: 2, storeId: 3 });
  });

  it('refuses to book, cancel or take a credential on the command line', () => {
    for (const flag of ['--book', '--cancel', '--create', '--delete', '--send'])
      expect(() => parseVerifyArgs(['--provider', 'pathao', flag])).toThrow(/read-only/);
    for (const flag of ['--client-secret', '--password', '--api-key', '--secret-key', '--token'])
      expect(() => parseVerifyArgs(['--provider', 'pathao', flag, 'x'])).toThrow(
        /environment variables only/,
      );
  });

  it('refuses unknown flags, bad values and odd ids', () => {
    expect(() => parseVerifyArgs(['--provider', 'dhl'])).toThrow(/pathao or steadfast/);
    expect(() => parseVerifyArgs(['--provider', 'pathao', '--environment', 'live'])).toThrow(
      /sandbox or production/,
    );
    expect(() => parseVerifyArgs(['--provider', 'pathao', '--what'])).toThrow(/Unknown argument/);
    expect(() => parseVerifyArgs(['--provider', 'pathao', '--city-id', 'abc'])).toThrow(
      /whole number/,
    );
    expect(() => parseVerifyArgs(['--provider', 'pathao', '--consignment', 'a b;rm'])).toThrow();
    expect(() => parseVerifyArgs(['--provider', 'pathao', '--consignment'])).toThrow(
      /needs a value/,
    );
  });
});

describe('readCredentials', () => {
  it('lists every missing variable by name and never reads values from anywhere else', () => {
    expect(readCredentials('pathao', {}).missing).toEqual([
      'COURIER_VERIFY_PATHAO_CLIENT_ID',
      'COURIER_VERIFY_PATHAO_CLIENT_SECRET',
    ]);
    expect(readCredentials('steadfast', { COURIER_VERIFY_STEADFAST_API_KEY: 'k' }).missing).toEqual(
      ['COURIER_VERIFY_STEADFAST_SECRET_KEY'],
    );
    expect(
      readCredentials('pathao', {
        COURIER_VERIFY_PATHAO_CLIENT_ID: 'i',
        COURIER_VERIFY_PATHAO_CLIENT_SECRET: 's',
        COURIER_VERIFY_PATHAO_USERNAME: 'u',
      }).missing,
    ).toEqual(['COURIER_VERIFY_PATHAO_PASSWORD']);
  });
});

describe('redactOutput', () => {
  it('removes secrets, tokens, emails and phone numbers', () => {
    const out = redactOutput(
      'bad key s3cr3t-key for rider@example.com +8801712345678 Bearer abc.def.ghi eyJhbGciOiJFZERTQSJ9abcdefghijkl',
      ['s3cr3t-key'],
    );
    expect(out).not.toMatch(/s3cr3t-key|rider@|01712345678|abc\.def|eyJhbGci/);
  });
});

function fakeAdapter(
  provider: 'pathao' | 'steadfast',
  over: Partial<Record<string, unknown>> = {},
) {
  const book = vi.fn();
  const cancel = vi.fn();
  const adapter = {
    provider,
    simulated: false,
    capabilities: {},
    verifyConnection: async () => ({ ok: true as const, details: ['Store 1: Secret Shop Name'] }),
    stores: async () => [{ id: 7, name: 'Secret Shop Name', active: true }],
    locations: {
      cities: async () => [{ id: 1, name: 'Dhaka' }],
      zones: async () => [{ id: 2, name: 'Mirpur' }],
      areas: async () => [{ id: 3, name: 'Section 10' }],
    },
    quote: async () => ({ serviceable: true, feeMinor: 6000, notes: [], raw: {} }),
    track: async () => ({
      consignmentId: '1',
      providerStatus: 'Pending',
      status: 'booked' as const,
      raw: {},
    }),
    findByReference: async () => null,
    book,
    cancel,
    ...over,
  };
  return { adapter: adapter as unknown as CourierAdapter, book, cancel };
}

describe('runVerification', () => {
  it('runs the Pathao read-only matrix and never calls book or cancel', async () => {
    const { adapter, book, cancel } = fakeAdapter('pathao');
    const args = parseVerifyArgs(['--provider', 'pathao', '--consignment', 'DL123']);
    const rows = await runVerification(readOnly(adapter as never), args, ['topsecret']);
    expect(Object.fromEntries(rows.map((r) => [r.check, r.status]))).toEqual({
      'auth / token': 'PASS',
      'store list': 'PASS',
      'city lookup': 'PASS',
      'zone lookup': 'PASS',
      'area lookup': 'PASS',
      'price quote': 'PASS',
      'tracking lookup': 'PASS',
      'lookup by our reference': 'N/A',
    });
    expect(book).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    // store names are never printed
    expect(formatMatrix(rows, args).join('\n')).not.toContain('Secret Shop Name');
  });

  it('exposes no way to book or cancel through the read-only view', () => {
    const { adapter } = fakeAdapter('pathao');
    const view = readOnly(adapter as never) as unknown as Record<string, unknown>;
    expect(view['book']).toBeUndefined();
    expect(view['cancel']).toBeUndefined();
  });

  it('marks a failing check FAIL, redacts what the provider echoed, and skips the rest after an auth failure', async () => {
    const { adapter } = fakeAdapter('pathao', {
      verifyConnection: async () => {
        throw new CourierError(
          'auth',
          'Pathao refused client topsecret-client for me@example.com',
          { status: 401 },
        );
      },
    });
    const args = parseVerifyArgs(['--provider', 'pathao']);
    const rows = await runVerification(readOnly(adapter as never), args, ['topsecret-client']);
    expect(rows[0]).toMatchObject({ check: 'auth / token', status: 'FAIL' });
    expect(rows[0]!.detail).not.toMatch(/topsecret-client|me@example/);
    expect(rows.filter((r) => r.status === 'SKIP').length).toBeGreaterThanOrEqual(5);
    expect(formatMatrix(rows, args).join('\n')).toMatch(/NOT verified/);
  });

  it('covers Steadfast: auth, tracking by consignment and lookup by reference', async () => {
    const { adapter } = fakeAdapter('steadfast', {
      stores: undefined,
      locations: undefined,
      quote: undefined,
    });
    const args = parseVerifyArgs([
      '--provider',
      'steadfast',
      '--reference',
      'OL-1',
      '--consignment',
      '99',
    ]);
    const rows = await runVerification(readOnly(adapter as never), args, []);
    const by = Object.fromEntries(rows.map((r) => [r.check, r]));
    expect(by['auth / token']!.status).toBe('PASS');
    expect(by['tracking lookup']!.status).toBe('PASS');
    expect(by['lookup by our reference']!.status).toBe('PASS');
    expect(by['lookup by our reference']!.detail).toMatch(/no booking/);
    expect(by['price quote']!.status).toBe('N/A');
  });

  it('skips checks that need arguments it was not given', async () => {
    const { adapter } = fakeAdapter('steadfast', {
      stores: undefined,
      locations: undefined,
      quote: undefined,
    });
    const rows = await runVerification(
      readOnly(adapter as never),
      parseVerifyArgs(['--provider', 'steadfast']),
      [],
    );
    expect(rows.filter((r) => r.status === 'SKIP').map((r) => r.check)).toEqual([
      'tracking lookup',
      'lookup by our reference',
    ]);
  });
});
