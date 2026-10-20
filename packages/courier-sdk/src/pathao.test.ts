import { describe, expect, it } from 'vitest';
import { CourierError } from './errors.js';
import { PathaoAdapter, PATHAO_BASE_URLS, codFeeEstimate } from './pathao.js';
import { fakeNetwork, timeoutError } from './testing.js';
import type { BookingRequest } from './types.js';

const SECRET = 'pathao-client-secret-DO-NOT-LEAK';
const PASSWORD = 'merchant-password-DO-NOT-LEAK';
const login = {
  body: {
    token_type: 'Bearer',
    expires_in: 432000,
    access_token: 'access-token-DO-NOT-LEAK',
    refresh_token: 'r',
  },
};

const adapter = (
  routes: Parameters<typeof fakeNetwork>[0],
  over: { password?: boolean; now?: () => number; env?: 'sandbox' | 'production' } = {},
) => {
  const net = fakeNetwork({
    'POST /aladdin/api/v1/external/login': login,
    'POST /aladdin/api/v1/issue-token': login,
    ...routes,
  });
  const a = new PathaoAdapter({
    credentials: {
      clientId: 'client-1',
      clientSecret: SECRET,
      ...(over.password ? { username: 'me@shop.test', password: PASSWORD } : {}),
    },
    settings: { environment: over.env ?? 'sandbox', storeId: 777 },
    fetch: net.fetch,
    sleep: async () => undefined,
    ...(over.now ? { now: over.now } : {}),
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
  weightKg: 1,
  note: 'Call before delivery',
  ...over,
});

const created = {
  body: {
    type: 'success',
    code: 200,
    message: 'Order Created Successfully',
    data: {
      consignment_id: 'DL121224VS8TTJ',
      merchant_order_id: 'OL-1001',
      order_status: 'Pending',
      delivery_fee: 60,
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

describe('Pathao: authentication', () => {
  it('logs in with the client id and secret on the official endpoint, then sends the bearer token', async () => {
    const { a, net } = adapter({
      'GET /aladdin/api/v1/stores': {
        body: { data: { data: [{ store_id: 777, store_name: 'Rina Fashion', is_active: 1 }] } },
      },
    });
    await a.stores();
    expect(net.requests[0]).toMatchObject({
      method: 'POST',
      path: '/aladdin/api/v1/external/login',
      body: { client_id: 'client-1', client_secret: SECRET },
    });
    expect(net.requests[0]!.headers['authorization']).toBeUndefined();
    expect(net.requests[1]!.headers['authorization']).toBe('Bearer access-token-DO-NOT-LEAK');
    expect(net.requests[0]!.url.startsWith(PATHAO_BASE_URLS.sandbox)).toBe(true);
  });

  it('uses the password grant (community-documented) only when a username and password are given', async () => {
    const { a, net } = adapter(
      { 'GET /aladdin/api/v1/stores': { body: { data: { data: [] } } } },
      { password: true },
    );
    await a.stores();
    expect(net.requests[0]).toMatchObject({
      path: '/aladdin/api/v1/issue-token',
      body: {
        grant_type: 'password',
        username: 'me@shop.test',
        password: PASSWORD,
        client_id: 'client-1',
      },
    });
  });

  it('talks to production only when asked', async () => {
    const { a, net } = adapter(
      { 'GET /aladdin/api/v1/stores': { body: { data: { data: [] } } } },
      { env: 'production' },
    );
    await a.stores();
    expect(new URL(net.requests[0]!.url).origin).toBe('https://api-hermes.pathao.com');
  });

  it('reuses a token until it is about to expire, then logs in again', async () => {
    let now = 1_000_000;
    const { a, net } = adapter(
      { 'GET /aladdin/api/v1/stores': { body: { data: { data: [] } } } },
      { now: () => now },
    );
    await a.stores();
    await a.stores();
    expect(net.requests.filter((r) => r.path.includes('login'))).toHaveLength(1);
    now += 432_000_000; // five days later
    await a.stores();
    expect(net.requests.filter((r) => r.path.includes('login'))).toHaveLength(2);
  });

  it('shares one login between requests made at the same moment', async () => {
    const { a, net } = adapter({ 'GET /aladdin/api/v1/stores': { body: { data: { data: [] } } } });
    await Promise.all([a.stores(), a.stores(), a.stores()]);
    expect(net.requests.filter((r) => r.path.includes('login'))).toHaveLength(1);
  });

  it('logs in again once when a token turns out to be stale, and gives up if it is still refused', async () => {
    const { a, net } = adapter({
      'GET /aladdin/api/v1/stores': [
        { status: 401, body: { message: 'Unauthenticated.' } },
        { body: { data: { data: [] } } },
      ],
    });
    await a.stores();
    expect(net.requests.map((r) => r.path)).toEqual([
      '/aladdin/api/v1/external/login',
      '/aladdin/api/v1/stores',
      '/aladdin/api/v1/external/login',
      '/aladdin/api/v1/stores',
    ]);
    const { a: b, net: n2 } = adapter({
      'GET /aladdin/api/v1/stores': { status: 401, body: { message: 'Unauthenticated.' } },
    });
    const e = await fail(b.stores());
    expect(e.kind).toBe('auth');
    expect(n2.requests.filter((r) => r.path.includes('login'))).toHaveLength(2); // one retry, never a loop
  });

  it('says the credentials are wrong when login is refused, without repeating them', async () => {
    const { a } = adapter({
      'POST /aladdin/api/v1/external/login': {
        status: 401,
        body: { message: 'Invalid credentials' },
      },
    });
    const e = await fail(a.verifyConnection());
    expect(e.kind).toBe('auth');
    expect(e.message).not.toContain(SECRET);
    expect(JSON.stringify(e)).not.toContain(SECRET);
  });
});

describe('Pathao: connection, stores and locations', () => {
  it('verifies by listing stores and reports plain facts only', async () => {
    const { a } = adapter({
      'GET /aladdin/api/v1/stores': {
        body: {
          data: {
            data: [
              { store_id: 777, store_name: 'Rina Fashion', is_active: 1 },
              { store_id: 778, store_name: 'Old', is_active: 0 },
            ],
          },
        },
      },
    });
    const check = await a.verifyConnection();
    expect(check.details).toEqual(['Store 777: Rina Fashion', 'Store 778: Old (not active)']);
    expect(JSON.stringify(check)).not.toContain('DO-NOT-LEAK');
  });

  it('explains an account with no store', async () => {
    const { a } = adapter({ 'GET /aladdin/api/v1/stores': { body: { data: { data: [] } } } });
    expect((await a.verifyConnection()).details[0]).toMatch(/no stores/);
  });

  it('reads cities, zones and areas from the paths in Pathao’s own plugin, with delivery and pickup availability', async () => {
    const { a, net } = adapter({
      'GET /aladdin/api/v1/countries/1/city-list': {
        body: { data: { data: [{ city_id: 1, city_name: 'Dhaka' }] } },
      },
      'GET /aladdin/api/v1/cities/1/zone-list': {
        body: { data: { data: [{ zone_id: 298, zone_name: 'Dhanmondi' }] } },
      },
      'GET /aladdin/api/v1/zones/298/area-list': {
        body: {
          data: {
            data: [
              {
                area_id: 3,
                area_name: 'Road 5',
                home_delivery_available: true,
                pickup_available: false,
              },
            ],
          },
        },
      },
    });
    expect(await a.locations.cities()).toEqual([{ id: 1, name: 'Dhaka' }]);
    expect(await a.locations.zones(1)).toEqual([{ id: 298, name: 'Dhanmondi' }]);
    expect(await a.locations.areas(298)).toEqual([
      { id: 3, name: 'Road 5', homeDelivery: true, pickup: false },
    ]);
    expect(net.requests.map((r) => r.path).filter((p) => !p.includes('login'))).toEqual([
      '/aladdin/api/v1/countries/1/city-list',
      '/aladdin/api/v1/cities/1/zone-list',
      '/aladdin/api/v1/zones/298/area-list',
    ]);
  });
});

describe('Pathao: booking', () => {
  it('sends exactly the fields Pathao documents, in the forms it expects', async () => {
    const { a, net } = adapter({ 'POST /aladdin/api/v1/orders': created });
    const r = await a.book(booking({ options: { cityId: 1, zoneId: 298, areaId: 3 } }));
    const sent = net.requests.find((q) => q.path === '/aladdin/api/v1/orders')!;
    expect(sent.body).toEqual({
      store_id: 777,
      merchant_order_id: 'OL-1001',
      recipient_name: 'Rina Akter',
      recipient_phone: '01712345678',
      recipient_secondary_phone: '',
      recipient_address: 'House 5, Road 3, Dhanmondi, Dhaka',
      recipient_city: 1,
      recipient_zone: 298,
      recipient_area: 3,
      delivery_type: 48,
      item_type: 2,
      special_instruction: 'Call before delivery',
      item_quantity: 2,
      item_weight: 1,
      item_description: 'Cotton tee x2',
      amount_to_collect: 1460,
    });
    expect(sent.headers['authorization']).toBe('Bearer access-token-DO-NOT-LEAK');
    expect(r).toMatchObject({
      consignmentId: 'DL121224VS8TTJ',
      providerStatus: 'Pending',
      status: 'booked',
      deliveryFeeMinor: 6000,
    });
  });

  it('leaves out city, zone and area when none were chosen (Pathao reads the address)', async () => {
    const { a, net } = adapter({ 'POST /aladdin/api/v1/orders': created });
    await a.book(booking());
    const sent = net.requests.find((q) => q.path === '/aladdin/api/v1/orders')!.body as Record<
      string,
      unknown
    >;
    for (const k of ['recipient_city', 'recipient_zone', 'recipient_area'])
      expect(sent[k]).toBeUndefined();
  });

  it('refuses, before sending anything, what Pathao would reject or what we cannot send faithfully', async () => {
    const { a, net } = adapter({ 'POST /aladdin/api/v1/orders': created });
    const cases: [Partial<BookingRequest>, RegExp][] = [
      [{ codAmountMinor: 146_050 }, /whole taka/i],
      [{ codAmountMinor: -100 }, /non-negative/],
      [{ weightKg: 0.1 }, /0\.5 to 10 kg/],
      [{ weightKg: 12 }, /0\.5 to 10 kg/],
      [{ weightKg: Number.NaN }, /0\.5 to 10 kg/],
      [{ options: { cityId: 'abc' } }, /city id/],
      [{ options: { zoneId: -3 } }, /zone id/],
      [{ options: { areaId: 1.5 } }, /area id/],
      [
        { recipient: { name: 'R', phone: '+8801712345678', address: 'short' } },
        /at least 10 characters/,
      ],
      [
        { recipient: { name: 'R', phone: '12345', address: 'House 5, Road 3, Dhanmondi' } },
        /Bangladeshi mobile/,
      ],
    ];
    for (const [over, message] of cases) {
      const e = await fail(a.book(booking(over)));
      expect(e.kind, JSON.stringify(over)).toBe('unsupported');
      expect(e.message).toMatch(message);
    }
    expect(net.requests.some((r) => r.path === '/aladdin/api/v1/orders')).toBe(false);
  });

  it('needs a store', async () => {
    const net = fakeNetwork({ 'POST /aladdin/api/v1/external/login': login });
    const a = new PathaoAdapter({
      credentials: { clientId: 'c', clientSecret: 's' },
      settings: { environment: 'sandbox' },
      fetch: net.fetch,
    });
    expect((await fail(a.book(booking()))).message).toMatch(/Choose a Pathao store/);
  });

  it('turns Pathao’s validation errors into field errors', async () => {
    const { a } = adapter({
      'POST /aladdin/api/v1/orders': {
        status: 422,
        body: {
          message: 'The given data was invalid.',
          errors: { recipient_phone: ['The recipient phone format is invalid.'] },
        },
      },
    });
    const e = await fail(a.book(booking()));
    expect(e.kind).toBe('validation');
    expect(e.fields).toEqual([
      { field: 'recipient_phone', message: 'The recipient phone format is invalid.' },
    ]);
  });

  it('never repeats a booking after a server error or a timeout (Pathao cannot be asked whether it exists)', async () => {
    for (const reply of [{ status: 500, body: {} }, timeoutError()]) {
      const { a, net } = adapter({ 'POST /aladdin/api/v1/orders': reply });
      const e = await fail(a.book(booking()));
      expect(e.outcomeUnknown).toBe(true);
      expect(net.requests.filter((r) => r.path === '/aladdin/api/v1/orders')).toHaveLength(1);
    }
    expect(adapter({}).a.capabilities.duplicateProtection).toBe('none');
  });

  it('treats a success reply with no consignment id as an unknown outcome', async () => {
    const { a } = adapter({ 'POST /aladdin/api/v1/orders': { body: { data: {} } } });
    const e = await fail(a.book(booking()));
    expect(e.outcomeUnknown).toBe(true);
  });

  it('keeps provider text and maps it, whatever case it arrives in', async () => {
    const { a } = adapter({
      'POST /aladdin/api/v1/orders': {
        body: { data: { consignment_id: 'C9', order_status: 'Pickup Requested' } },
      },
    });
    expect(await a.book(booking())).toMatchObject({
      providerStatus: 'Pickup Requested',
      status: 'booked',
    });
  });
});

describe('Pathao: estimate and tracking', () => {
  it('quotes a fee from city and zone, and shows the COD charge as an estimate', async () => {
    const { a, net } = adapter({
      'POST /aladdin/api/v1/merchant/price-plan': {
        body: {
          data: { price: 80, discount: 20, final_price: 60, cod_enabled: 1, cod_percentage: 0.01 },
        },
      },
    });
    const q = await a.quote({
      recipient: { address: 'x' },
      codAmountMinor: 146_000,
      weightKg: 1,
      options: { cityId: 1, zoneId: 298 },
    });
    expect(q).toMatchObject({
      serviceable: true,
      feeMinor: 6000,
      codEnabled: true,
      codFeeMinor: 1460,
    });
    expect(net.requests.find((r) => r.path.endsWith('price-plan'))!.body).toEqual({
      store_id: 777,
      item_type: 2,
      delivery_type: 48,
      item_weight: 1,
      recipient_city: 1,
      recipient_zone: 298,
    });
  });

  it('works the COD charge out in whole paisa from the percentage text, and says it is an estimate', async () => {
    expect(codFeeEstimate(146_000, 0.01)).toBe(1460);
    expect(codFeeEstimate(100_050, '0.0125')).toBe(1251); // 1.25% of 1,000.50, rounded half up
    expect(codFeeEstimate(1, '0.01')).toBe(0);
    expect(codFeeEstimate(146_000, 0)).toBeUndefined();
    expect(codFeeEstimate(146_000, 1)).toBeUndefined(); // 100%: surely a different unit, so no guess
    expect(codFeeEstimate(146_000, 1.5)).toBeUndefined();
    expect(codFeeEstimate(146_000, 'abc')).toBeUndefined();
    expect(codFeeEstimate(146_000, undefined)).toBeUndefined();
    const { a } = adapter({
      'POST /aladdin/api/v1/merchant/price-plan': {
        body: { data: { final_price: 60, cod_percentage: 0.01 } },
      },
    });
    const q = await a.quote({
      recipient: { address: 'x' },
      codAmountMinor: 146_000,
      options: { cityId: 1, zoneId: 298 },
    });
    expect(q.notes.join(' ')).toMatch(/estimate.*unit/i);
  });

  it('asks for a city and zone rather than guessing', async () => {
    const { a } = adapter({});
    expect(
      (await fail(a.quote({ recipient: { address: 'x' }, codAmountMinor: 0 }))).message,
    ).toMatch(/city and zone/);
  });

  it('tracks by consignment id and maps the status, keeping Pathao’s words', async () => {
    const { a, net } = adapter({
      'GET /aladdin/api/v1/orders/DL1/info': {
        body: {
          data: {
            consignment_id: 'DL1',
            order_status: 'Delivery Failed',
            order_status_slug: 'delivery-failed',
            updated_at: '2026-10-18 10:00:00',
          },
        },
      },
    });
    expect(await a.track({ consignmentId: 'DL1', reference: 'OL-1001' })).toMatchObject({
      consignmentId: 'DL1',
      providerStatus: 'Delivery Failed',
      status: 'delivery_failed',
      updatedAt: '2026-10-18 10:00:00',
    });
    expect(net.requests.find((r) => r.path.endsWith('/info'))!.method).toBe('GET');
  });

  it('retries a tracking read through a server error, and cannot track a booking without an id', async () => {
    const { a, net } = adapter({
      'GET /aladdin/api/v1/orders/DL1/info': [
        { status: 503 },
        { body: { data: { order_status: 'Delivered' } } },
      ],
    });
    expect((await a.track({ consignmentId: 'DL1', reference: 'r' })).status).toBe('delivered');
    expect(net.requests.filter((r) => r.path.endsWith('/info'))).toHaveLength(2);
    expect((await fail(a.track({ consignmentId: null, reference: 'r' }))).kind).toBe('unsupported');
  });

  it('offers no cancel, because Pathao documents none', () => {
    expect(adapter({}).a.cancel).toBeUndefined();
    expect(adapter({}).a.capabilities.cancel).toBe(false);
  });

  it('declares the weights it takes, which are the ones its booking enforces', async () => {
    const { a } = adapter({});
    expect(a.capabilities.weightKg).toEqual({ min: 0.5, max: 10 });
    for (const weightKg of [0.4, 10.1])
      expect((await fail(a.book({ ...booking(), weightKg }))).message).toMatch(/0\.5 to 10 kg/);
  });

  it('never exposes the secrets in any result or error', async () => {
    const { a } = adapter({
      'POST /aladdin/api/v1/orders': created,
      'POST /aladdin/api/v1/merchant/price-plan': { status: 500, body: { message: 'boom' } },
    });
    const ok = await a.book(booking());
    expect(JSON.stringify(ok)).not.toMatch(/DO-NOT-LEAK/);
    const e = await fail(
      a.quote({
        recipient: { address: 'x' },
        codAmountMinor: 0,
        options: { cityId: 1, zoneId: 2 },
      }),
    );
    expect(JSON.stringify({ m: e.message, k: e.kind, f: e.fields })).not.toMatch(/DO-NOT-LEAK/);
  });
});
