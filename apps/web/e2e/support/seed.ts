import type { APIRequestContext } from '@playwright/test';
import { API, createAccount, PASSWORD } from '../fixtures';

/**
 * A believable business for looking at the screens: products with cost prices, customers, orders in every state, a connected
 * (simulated) courier with parcels at different points, recorded costs and an imported statement. Created through the real
 * API, so what the screens show is what the product does.
 */
export async function seedBusiness(request: APIRequestContext, prefix = 'shots') {
  const account = await createAccount(request, prefix);
  const login = await request.post(`${API}/v1/auth/login`, {
    headers: { 'x-client': 'web' },
    data: { email: account.email, password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  const post = async (path: string, data: object = {}, method: 'post' | 'patch' = 'post') => {
    const res = await request[method](`${API}${path}`, { headers, data });
    if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
    return res.json();
  };
  const key = () => `seed-${Math.random().toString(36).slice(2, 12)}`;

  const catalog = [
    ['Cotton T-Shirt (M)', 'TS-COT-M', 650, 400, 38, 10],
    ['Cargo Joggers (32)', 'CJ-BLK-32', 1100, 700, 21, 8],
    ['Floral Three-piece (L)', 'FTP-L-ROSE', 3290, 2150, 3, 5],
    ['Matte Lipstick Set (Rose)', 'MLS-ROSE', 550, 380, 4, 5],
    ['Silver Hoop Earrings', 'SHE-SLV', 590, 310, 22, 6],
    ['Wireless Earbuds (Black)', 'WEB-BLK', 2990, 2050, 2, 5],
    ['Leather Crossbody Bag', 'LCB-TAN', 1850, 1180, 0, 4],
  ] as const;
  const variants: { id: string; price: number }[] = [];
  for (const [name, sku, price, cost, qty, reorder] of catalog) {
    const p = await post('/v1/products', {
      name,
      variants: [{ sku, priceMinor: price * 100, costMinor: cost * 100, reorderPoint: reorder }],
    });
    const id = p.variants[0].id as string;
    variants.push({ id, price });
    if (qty > 0)
      await post('/v1/inventory/receive', {
        variantId: id,
        quantity: qty > reorder ? qty + 8 : qty,
        reason: 'Opening stock',
        idempotencyKey: key(),
      });
  }
  await post('/v1/couriers/mock', { settings: {} }, 'patch');

  const people = [
    ['Rahim Uddin', '01712345678', 'Mirpur-10', 'Dhaka'],
    ['Sadia Islam', '01611908712', 'Agrabad', 'Chattogram'],
    ['Nusrat Jahan', '01819224410', 'Dhanmondi', 'Dhaka'],
    ['Tanvir Ahmed', '01911567823', 'Uttara', 'Dhaka'],
    ['Farhana Akter', '01717660231', 'Banani', 'Dhaka'],
    ['Imran Hossain', '01555120934', 'Zindabazar', 'Sylhet'],
  ] as const;
  const orders: { id: string; number: number }[] = [];
  const plan: { who: number; items: [number, number][]; steps: string[]; book?: string[] }[] = [
    {
      who: 0,
      items: [
        [0, 2],
        [1, 1],
      ],
      steps: ['confirmed', 'ready_to_ship'],
      book: ['picked_up', 'in_transit', 'out_for_delivery'],
    },
    {
      who: 1,
      items: [
        [3, 2],
        [4, 1],
      ],
      steps: [],
    },
    {
      who: 2,
      items: [[2, 1]],
      steps: ['confirmed', 'ready_to_ship'],
      book: ['picked_up', 'in_transit', 'delivered'],
    },
    { who: 3, items: [[6, 1]], steps: [] },
    {
      who: 4,
      items: [[4, 2]],
      steps: ['confirmed', 'ready_to_ship'],
      book: ['picked_up', 'in_transit', 'delivered'],
    },
    {
      who: 5,
      items: [[5, 1]],
      steps: ['confirmed', 'ready_to_ship'],
      book: ['picked_up', 'delivery_failed', 'returning'],
    },
    {
      who: 1,
      items: [[0, 3]],
      steps: ['confirmed', 'ready_to_ship'],
      book: ['picked_up', 'in_transit', 'delivered'],
    },
    { who: 0, items: [[1, 2]], steps: ['confirmed', 'ready_to_ship'] },
  ];
  for (const o of plan) {
    const [name, phone, area, district] = people[o.who]!;
    const order = await post('/v1/orders', {
      customer: { name, phone },
      address: {
        recipientName: name,
        phone,
        line1: 'House 12, Road 5, Block C',
        area,
        district,
        division:
          district === 'Chattogram' ? 'Chattogram' : district === 'Sylhet' ? 'Sylhet' : 'Dhaka',
      },
      items: o.items.map(([v, quantity]) => ({ variantId: variants[v]!.id, quantity })),
      deliveryChargeMinor: 13_000,
      source: o.who % 2 ? 'instagram' : 'facebook',
      idempotencyKey: key(),
    });
    for (const status of o.steps) await post(`/v1/orders/${order.id}/status`, { status });
    if (o.book) {
      const s = await post(`/v1/orders/${order.id}/shipments`, {
        provider: 'mock',
        idempotencyKey: key(),
      });
      for (const event of o.book) await post(`/v1/shipments/${s.id}/simulate`, { event });
    }
    orders.push({ id: order.id, number: order.orderNumber });
  }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  await post('/v1/finance/costs', {
    kind: 'advertising',
    amountMinor: 240_000,
    incurredOn: today,
    note: 'Facebook and Instagram boost',
    idempotencyKey: key(),
  });
  await post('/v1/finance/costs', {
    kind: 'packaging',
    amountMinor: 44_000,
    incurredOn: today,
    note: 'Boxes and tape',
    idempotencyKey: key(),
  });
  const head =
    'transaction_id,consignment_id,tracking_code,reference,phone,date,type,collected,delivery_charge,cod_fee,return_charge,other_deduction,net,note';
  await post('/v1/settlements/import', {
    provider: 'steadfast',
    fileName: 'steadfast-st-2610-03.csv',
    statementRef: 'ST-2610-03',
    csv: [
      head,
      `,SF-NOT-OURS-1,,,,${today},cod,2450,85,24.5,0,0,,`,
      `,,,,,${today},adjustment,0,0,0,0,25,,Monthly account fee`,
    ].join('\n'),
  });
  return { account, token: accessToken, orders, variants };
}
