// Creates a demo business with products, stock and orders through the public API, so the app has something to show.
// Usage: node scripts/mobile/seed-demo.mjs [apiUrl]   (default http://localhost:4100; see test-api.mjs)
const API = process.argv[2] ?? 'http://localhost:4100';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(API))
  throw new Error(
    `${API} is not a local address: this script creates demo data with a known password`,
  );
const stamp = Date.now().toString(36);
const email = `demo-${stamp}@example.test`;
const password = 'Demo-password-1';

async function call(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const auth = await call('POST', '/v1/auth/register', {
  email,
  password,
  name: 'Rina Akter',
  tenantName: 'Urban Thread BD',
});
const token = auth.accessToken;

const products = [];
for (const [name, sku, price, cost, qty] of [
  ['Floral Three-piece', 'FTP-L-ROSE', 329000, 215000, 12],
  ['Matte Lipstick Set', 'MLS-ROSE', 86700, 52000, 4],
  ['Wireless Earbuds', 'WEB-BLK', 189000, 120000, 2],
  ['Cotton T-Shirt', 'TEE-M', 65000, 40000, 30],
]) {
  const p = await call(
    'POST',
    '/v1/products',
    { name, variants: [{ sku, priceMinor: price, costPriceMinor: cost, reorderPoint: 5 }] },
    token,
  );
  const variantId = p.variants[0].id;
  await call('POST', '/v1/inventory/receive', { variantId, quantity: qty }, token);
  products.push({ name, variantId });
}

const people = [
  ['Sadia Islam', '01611908712', 'Agrabad', 'Chattogram', 'Chattogram'],
  ['Rahim Uddin', '01712345678', 'Mirpur', 'Dhaka', 'Dhaka'],
  ['Nusrat Jahan', '01819224410', 'Zindabazar', 'Sylhet', 'Sylhet'],
];
let n = 0;
for (const [name, phone, area, district, division] of people) {
  const order = await call(
    'POST',
    '/v1/orders',
    {
      customer: { name, phone },
      address: {
        recipientName: name,
        phone,
        line1: `House ${n + 3}, Road 4`,
        area,
        district,
        division,
      },
      items: [{ variantId: products[n].variantId, quantity: n === 1 ? 2 : 1 }],
      deliveryChargeMinor: 6000,
      idempotencyKey: `seed-${stamp}-${n}`,
      source: ['facebook', 'instagram', 'whatsapp'][n],
      confirm: n > 0,
    },
    token,
  );
  if (n === 2)
    await call('POST', `/v1/orders/${order.id}/status`, { status: 'ready_to_ship' }, token);
  n += 1;
}

console.log(JSON.stringify({ api: API, email, password }, null, 2));
