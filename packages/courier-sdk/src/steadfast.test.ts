import { describe, expect, it } from 'vitest';
import { CourierError } from './errors.js';
import { STEADFAST_BASE_URLS, SteadfastAdapter } from './steadfast.js';
import { fakeNetwork, timeoutError } from './testing.js';
import type { BookingRequest } from './types.js';

const KEY = 'api-key-DO-NOT-LEAK';
const SECRET = 'secret-key-DO-NOT-LEAK';

const adapter = (
  routes: Parameters<typeof fakeNetwork>[0],
  host: 'steadfast' | 'packzy' = 'steadfast',
) => {
  const net = fakeNetwork(routes);
  const a = new SteadfastAdapter({
    credentials: { apiKey: KEY, secretKey: SECRET },
    settings: { host },
    fetch: net.fetch,
    sleep: async () => undefined,
  });
  return { a, net };
};
const booking = (over: Partial<BookingRequest> = {}): BookingRequest => ({
  reference: 'OL-1001',
  recipient: {
    name: 'Rina Akter',
    phone: '+8801712345678',
    address: 'House 5, Road 3, Dhanmondi, Dhaka',
  },
  codAmountMinor: 146_000,
  itemDescription: 'Cotton tee x2',
  itemQuantity: 2,
  note: 'Call before delivery',
  ...over,
});
const created = {
  body: {
    status: 200,
    message: 'Consignment has been created successfully.',
    consignment: {
      consignment_id: 1424107,
      invoice: 'OL-1001',
      tracking_code: '15BAEB8A',
      status: 'in_review',
      cod_amount: 1460,
    },
  },
};
const fail = async (p: Promise<unknown>): Promise<CourierError> => {
  try {
    await p;
  } catch (e) {
    return e as CourierError;
  }
  throw new Error('expected a failure');
};

describe('Steadfast: authentication and connection', () => {
  it('sends the key and secret in the Api-Key and Secret-Key headers, to the allowlisted host only', async () => {
    const { a, net } = adapter({
      'GET /api/v1/get_balance': { body: { status: 200, current_balance: 5000 } },
    });
    await a.verifyConnection();
    expect(net.requests[0]!.headers).toMatchObject({ 'api-key': KEY, 'secret-key': SECRET });
    expect(net.requests[0]!.url).toBe(`${STEADFAST_BASE_URLS.steadfast}/get_balance`);
    const { a: b, net: n2 } = adapter(
      { 'GET /api/v1/get_balance': { body: { status: 200, current_balance: 1 } } },
      'packzy',
    );
    await b.verifyConnection();
    expect(new URL(n2.requests[0]!.url).host).toBe('portal.packzy.com');
  });

  it('does not show the balance, and does not echo credentials', async () => {
    const { a } = adapter({
      'GET /api/v1/get_balance': { body: { status: 200, current_balance: 987_654 } },
    });
    const check = await a.verifyConnection();
    expect(JSON.stringify(check)).not.toMatch(/987654|DO-NOT-LEAK/);
  });

  it('reports rejected credentials without retrying (repeated failures can lock the account)', async () => {
    const { a, net } = adapter({
      'GET /api/v1/get_balance': { status: 401, body: { message: 'Unauthorized' } },
    });
    const e = await fail(a.verifyConnection());
    expect(e.kind).toBe('auth');
    expect(net.requests).toHaveLength(1);
  });
});

describe('Steadfast: booking', () => {
  it('sends the documented fields with COD in whole taka and a local phone number', async () => {
    const { a, net } = adapter({ 'POST /api/v1/create_order': created });
    const r = await a.book(booking());
    expect(net.requests[0]!.body).toEqual({
      invoice: 'OL-1001',
      recipient_name: 'Rina Akter',
      recipient_phone: '01712345678',
      recipient_address: 'House 5, Road 3, Dhanmondi, Dhaka',
      cod_amount: 1460,
      note: 'Call before delivery',
      item_description: 'Cotton tee x2',
      total_lot: 2,
    });
    expect(r).toMatchObject({
      consignmentId: '1424107',
      trackingCode: '15BAEB8A',
      providerStatus: 'in_review',
      status: 'booked',
    });
    expect(r.trackingUrl).toBeUndefined(); // we never invent tracking links
  });

  it('accepts either documented reply shape, and uses the tracking link only when Steadfast sends one', async () => {
    const flat = adapter({
      'POST /api/v1/create_order': {
        body: {
          status: 200,
          consignment_id: 9,
          tracking_code: 'T9',
          tracking_link: 'https://example.test/t/T9',
          status_text: 'x',
        },
      },
    });
    expect(await flat.a.book(booking())).toMatchObject({
      consignmentId: '9',
      trackingUrl: 'https://example.test/t/T9',
      status: 'booked',
    });
  });

  it.each([
    ['http://example.test/t/T9'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>1</script>'],
    ['https://user:pw@example.test/t/T9'],
    ['//example.test/t/T9'],
    ['not a url'],
  ])('drops a tracking link that is not plain https (%s)', async (link) => {
    const { a } = adapter({
      'POST /api/v1/create_order': {
        body: { status: 200, consignment_id: 9, tracking_code: 'T9', tracking_link: link },
      },
    });
    const r = await a.book(booking());
    expect(r.trackingUrl).toBeUndefined();
    expect(r.trackingCode).toBe('T9'); // the rest of the booking is kept
  });

  it('refuses invalid input before sending', async () => {
    const { a, net } = adapter({ 'POST /api/v1/create_order': created });
    const cases: [Partial<BookingRequest>, RegExp][] = [
      [{ codAmountMinor: 100_050 }, /whole taka/i],
      [{ codAmountMinor: 100_000_100 }, /1,000,000/],
      [{ reference: 'has spaces' }, /letters, digits/],
      [{ reference: 'x'.repeat(101) }, /letters, digits/],
      [
        {
          recipient: {
            name: 'N'.repeat(101),
            phone: '+8801712345678',
            address: 'a long enough address',
          },
        },
        /100 characters/,
      ],
      [
        { recipient: { name: 'N', phone: '+8801712345678', address: 'a'.repeat(491) } },
        /490 characters/,
      ],
    ];
    for (const [over, message] of cases) {
      const e = await fail(a.book(booking(over)));
      expect(e.kind, JSON.stringify(over).slice(0, 60)).toBe('unsupported');
      expect(e.message).toMatch(message);
    }
    expect(net.requests).toHaveLength(0);
  });

  it('turns a refusal into a validation error with the reason', async () => {
    const { a } = adapter({
      'POST /api/v1/create_order': {
        status: 400,
        body: { status: 400, message: 'The invoice has already been taken.' },
      },
    });
    const e = await fail(a.book(booking()));
    expect(e.kind).toBe('validation');
    expect(e.message).toBe('The invoice has already been taken.');
    expect(e.outcomeUnknown).toBe(true); // the first attempt went through: settle it by reference
  });

  it('treats a duplicate invoice refused with a 200 reply or a field error the same way, and other refusals as final', async () => {
    const inBody = adapter({
      'POST /api/v1/create_order': {
        body: { status: 400, message: 'The invoice has already been taken.' },
      },
    });
    expect((await fail(inBody.a.book(booking()))).outcomeUnknown).toBe(true);
    const field = adapter({
      'POST /api/v1/create_order': { status: 422, body: { errors: { invoice: ['Bad invoice'] } } },
    });
    expect((await fail(field.a.book(booking()))).outcomeUnknown).toBe(true);
    const other = adapter({
      'POST /api/v1/create_order': { status: 400, body: { message: 'Invalid phone number' } },
    });
    expect((await fail(other.a.book(booking()))).outcomeUnknown).toBe(false);
    const otherBody = adapter({
      'POST /api/v1/create_order': { body: { status: 400, message: 'Invalid phone number' } },
    });
    expect((await fail(otherBody.a.book(booking()))).outcomeUnknown).toBe(false);
  });

  it('does not repeat a booking after a timeout or a server error, and says the outcome is unknown', async () => {
    for (const reply of [timeoutError(), { status: 502, body: {} }]) {
      const { a, net } = adapter({ 'POST /api/v1/create_order': reply });
      const e = await fail(a.book(booking()));
      expect(e.outcomeUnknown).toBe(true);
      expect(net.requests).toHaveLength(1);
    }
  });

  it('waits and tries again after a 429, because the booking was refused, not made', async () => {
    const { a, net } = adapter({
      'POST /api/v1/create_order': [
        { status: 429, body: {}, headers: { 'retry-after': '2' } },
        created,
      ],
    });
    expect((await a.book(booking())).consignmentId).toBe('1424107');
    expect(net.requests).toHaveLength(2);
  });
});

describe('Steadfast: finding a booking again, and tracking', () => {
  it('can look a booking up by our invoice, so a timed-out booking is settled by asking, not repeating', async () => {
    const { a, net } = adapter({
      'GET /api/v1/status_by_invoice/OL-1001': {
        body: { status: 200, delivery_status: 'in_review' },
      },
    });
    expect(await a.findByReference('OL-1001')).toMatchObject({
      consignmentId: null,
      providerStatus: 'in_review',
      status: 'booked',
    });
    expect(net.requests[0]!.path).toBe('/api/v1/status_by_invoice/OL-1001');
    expect(a.capabilities.duplicateProtection).toBe('reference');
  });

  it('returns the consignment id when the lookup by invoice gives one', async () => {
    const { a } = adapter({
      'GET /api/v1/status_by_invoice/OL-1001': {
        body: { status: 200, consignment_id: 1424107, delivery_status: 'in_review' },
      },
    });
    expect((await a.findByReference('OL-1001'))?.consignmentId).toBe('1424107');
  });

  it('says “no such booking” for an unknown invoice, in either of the ways Steadfast answers', async () => {
    expect(
      await adapter({
        'GET /api/v1/status_by_invoice/': { status: 404, body: {} },
      }).a.findByReference('X'),
    ).toBeNull();
    expect(
      await adapter({
        'GET /api/v1/status_by_invoice/': { body: { status: 404, message: 'Not found' } },
      }).a.findByReference('X'),
    ).toBeNull();
  });

  it('tracks by consignment id when it has one, and by invoice when it does not', async () => {
    const { a, net } = adapter({
      'GET /api/v1/status_by_cid/1424107': {
        body: { status: 200, delivery_status: 'delivered_approval_pending' },
      },
      'GET /api/v1/status_by_invoice/OL-1001': { body: { status: 200, delivery_status: 'hold' } },
    });
    expect(await a.track({ consignmentId: '1424107', reference: 'OL-1001' })).toMatchObject({
      providerStatus: 'delivered_approval_pending',
      status: 'delivered',
    });
    expect(await a.track({ consignmentId: null, reference: 'OL-1001' })).toMatchObject({
      providerStatus: 'hold',
      status: 'on_hold',
    });
    expect(net.requests.map((r) => r.path)).toEqual([
      '/api/v1/status_by_cid/1424107',
      '/api/v1/status_by_invoice/OL-1001',
    ]);
  });

  it('retries a status read through a server error and preserves the provider’s words for statuses it does not know', async () => {
    const { a, net } = adapter({
      'GET /api/v1/status_by_cid/1': [
        { status: 503, body: {} },
        { body: { status: 200, delivery_status: 'brand_new_status' } },
      ],
    });
    expect(await a.track({ consignmentId: '1', reference: 'r' })).toMatchObject({
      providerStatus: 'brand_new_status',
      status: 'unknown',
    });
    expect(net.requests).toHaveLength(2);
  });

  it('has no estimate and no cancel, because Steadfast documents neither', () => {
    const { a } = adapter({});
    expect(a.quote).toBeUndefined();
    expect(a.cancel).toBeUndefined();
    expect(a.capabilities).toMatchObject({ quote: false, cancel: false, webhooks: true });
    expect(a.capabilities.weightKg).toEqual({ min: 0.1, max: 50 });
  });

  it('never exposes the key or secret in a result or an error', async () => {
    const { a } = adapter({
      'POST /api/v1/create_order': created,
      'GET /api/v1/status_by_cid/1': { status: 500, body: { message: 'oops' } },
    });
    expect(JSON.stringify(await a.book(booking()))).not.toMatch(/DO-NOT-LEAK/);
    const e = await fail(a.track({ consignmentId: '1', reference: 'r' }));
    expect(JSON.stringify({ m: e.message })).not.toMatch(/DO-NOT-LEAK/);
  });
});
