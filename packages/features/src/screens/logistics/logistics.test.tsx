import type {
  CourierEntry,
  Discrepancy,
  OutstandingCod,
  SettlementBatch,
  SettlementBatchDetail,
  SettlementItem,
  ShipmentDetail,
  ShipmentRow,
  ShipmentSummary,
} from '@orderloop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dimensions } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../../test/mount';
import { CodReconciliationScreen } from './CodReconciliationScreen';
import { SettlementDetailScreen } from './SettlementDetailScreen';
import { ShipmentsScreen } from './ShipmentsScreen';

/** jsdom reports no width, which reads as a phone; the table layouts are tested at a desktop width. */
const setWidth = (width: number) => {
  const original = Dimensions.get.bind(Dimensions);
  vi.spyOn(Dimensions, 'get').mockImplementation((key) =>
    key === 'window' ? { width, height: 900, scale: 1, fontScale: 1 } : original(key),
  );
};
beforeEach(() => setWidth(1440));
afterEach(() => vi.restoreAllMocks());

const uuid = (n: number) => `0197b0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

// ---- couriers and shipments ------------------------------------------------------------------------------------------

const courier = (
  provider: CourierEntry['provider'],
  name: string,
  connection: Partial<NonNullable<CourierEntry['connection']>> | null,
): CourierEntry => ({
  provider,
  name,
  simulated: provider === 'mock',
  capabilities: {
    quote: false,
    tracking: true,
    webhooks: false,
    cancel: false,
    returns: false,
    locations: false,
    duplicateProtection: 'none',
  },
  environments: provider === 'mock' ? ['simulated'] : ['production'],
  credentialFields: [],
  available: true,
  unavailableReason: null,
  connection: connection && {
    id: uuid(900),
    environment: provider === 'mock' ? 'simulated' : 'production',
    hasCredentials: true,
    hasWebhookSecret: false,
    settings: {},
    enabled: true,
    webhookUrl: null,
    lastCheckedAt: '2026-10-17T06:00:00.000Z',
    lastCheckOk: true,
    lastCheckMessage: null,
    updatedAt: '2026-10-17T06:00:00.000Z',
    ...connection,
  },
});

const couriers = [
  courier('pathao', 'Pathao', {}),
  courier('steadfast', 'Steadfast', {
    lastCheckOk: false,
    lastCheckMessage: 'The API key expired',
  }),
  courier('mock', 'Simulated courier', null),
];

const summary: ShipmentSummary = {
  recentDays: 7,
  statsDays: 30,
  bookedToday: 9,
  awaitingPickup: 3,
  onTheWay: 8,
  delayed: 2,
  delivered: 96,
  returned: 7,
  codOnTheWayMinor: 4_585_000,
  codOnTheWayCount: 11,
  providers: [
    {
      provider: 'pathao',
      simulated: false,
      shipments: 68,
      delivered: 60,
      deliveredRate: 0.937,
      avgDeliveryDays: 2.1,
    },
    {
      provider: 'steadfast',
      simulated: false,
      shipments: 46,
      delivered: 40,
      deliveredRate: null,
      avgDeliveryDays: null,
    },
  ],
};

const row = (n: number, over: Partial<ShipmentRow> = {}): ShipmentRow => ({
  id: uuid(n),
  orderId: uuid(100 + n),
  orderNumber: 1000 + n,
  customerName: `Buyer ${n}`,
  provider: 'pathao',
  environment: 'production',
  simulated: false,
  status: 'in_transit',
  providerStatus: null,
  consignmentId: `PT-${n}`,
  reference: `OL-${1000 + n}`,
  trackingCode: null,
  codAmountMinor: 245_000,
  deliveryFeeMinor: 8_500,
  bookedAt: '2026-10-16T08:00:00.000Z',
  updatedAt: '2026-10-17T05:10:00.000Z',
  ...over,
});

const detail = (r: ShipmentRow, over: Partial<ShipmentDetail> = {}): ShipmentDetail => ({
  id: r.id,
  orderId: r.orderId,
  orderNumber: r.orderNumber,
  provider: r.provider,
  environment: r.environment,
  simulated: r.simulated,
  status: r.status,
  providerStatus: 'Out for delivery',
  consignmentId: r.consignmentId,
  reference: r.reference,
  trackingCode: 'TRK1',
  trackingUrl: null,
  attempt: 1,
  codAmountMinor: r.codAmountMinor,
  deliveryFeeMinor: r.deliveryFeeMinor,
  failureReason: null,
  bookedAt: r.bookedAt,
  lastEventAt: '2026-10-17T05:10:00.000Z',
  lastSyncedAt: null,
  createdAt: '2026-10-16T08:00:00.000Z',
  actions: {
    canRefresh: true,
    canCancel: false,
    needsResolution: false,
    canSimulate: false,
    canMarkCancelled: false,
  },
  events: [
    {
      id: uuid(501),
      source: 'booking',
      providerStatus: 'Pending',
      mappedStatus: 'booked',
      applied: true,
      note: 'Consignment created from OrderLoop',
      occurredAt: '2026-10-16T08:00:00.000Z',
      createdAt: '2026-10-16T08:00:00.000Z',
    },
    {
      id: uuid(502),
      source: 'webhook',
      providerStatus: 'Picked up',
      mappedStatus: 'picked_up',
      applied: true,
      note: null,
      occurredAt: '2026-10-16T10:00:00.000Z',
      createdAt: '2026-10-16T10:00:00.000Z',
    },
    {
      id: uuid(503),
      source: 'webhook',
      providerStatus: 'Picked up',
      mappedStatus: 'picked_up',
      applied: false,
      note: 'Repeat of an update we already have',
      occurredAt: '2026-10-16T10:05:00.000Z',
      createdAt: '2026-10-16T10:05:00.000Z',
    },
  ],
  ...over,
});

const shipmentsApi = (rows: ShipmentRow[], extra: Record<string, unknown> = {}) => {
  const list = vi.fn(async () => ({
    items: rows,
    total: rows.length,
    page: 1,
    pages: 1,
    statusCounts: { in_transit: 2, delivered: 1, booked: 1 },
  }));
  const get = vi.fn(async (id: string) => detail(rows.find((r) => r.id === id)!));
  const refresh = vi.fn(async (id: string) => detail(rows.find((r) => r.id === id)!));
  return {
    couriers: { list: vi.fn(async () => couriers) },
    shipments: { list, stats: vi.fn(async () => summary), get, refresh, ...extra },
  };
};

describe('couriers and shipments', () => {
  it('shows each courier with its real figures, a banner for the one that needs attention, and the KPIs', async () => {
    mount(<ShipmentsScreen />, shipmentsApi([row(1)]));
    expect(await screen.findByRole('heading', { name: 'Couriers & shipments' })).toBeTruthy();
    expect(await screen.findByText('114 shipments · 3 courier integrations')).toBeTruthy();

    const banner = await screen.findByRole('status');
    expect(within(banner).getByText('Steadfast needs attention')).toBeTruthy();
    expect(within(banner).getByText('The API key expired')).toBeTruthy();

    const pathao = await screen.findByRole('group', { name: 'Pathao' });
    expect(within(pathao).getByText('68')).toBeTruthy();
    expect(within(pathao).getByText('93.7%')).toBeTruthy();
    expect(within(pathao).getByText('2.1 days')).toBeTruthy();
    expect(within(pathao).getByText('Connected')).toBeTruthy();
    // Unknown figures are a dash, never an invented number.
    const steadfast = screen.getByRole('group', { name: 'Steadfast' });
    expect(within(steadfast).getByText('Action required')).toBeTruthy();
    expect(within(steadfast).getAllByText('—')).toHaveLength(2);
    const sim = screen.getByRole('group', { name: 'Simulated courier' });
    expect(within(sim).getByText('SIMULATED')).toBeTruthy();
    expect(within(sim).getByText('Not connected')).toBeTruthy();
    expect(within(sim).getByRole('button', { name: 'Connect Simulated courier' })).toBeTruthy();
    expect(screen.queryByText('RedX')).toBeNull();

    expect(screen.getByRole('group', { name: 'Booked today: 9' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Delivered (7d): 96' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'COD on the way: ৳45,850.00' })).toBeTruthy();
    expect(screen.getByText('2 delayed')).toBeTruthy();
  });

  it('lists shipments and sends the filters and page to the server as the API expects them', async () => {
    const api = shipmentsApi([
      row(1),
      row(2, { status: 'delivered', simulated: true, provider: 'mock' }),
    ]);
    mount(<ShipmentsScreen />, api);
    const first = await screen.findByRole('row', { name: /PT-1/ });
    expect(within(first).getByText('#1001 · Buyer 1')).toBeTruthy();
    expect(within(first).getByText('In transit')).toBeTruthy();
    expect(within(first).getByText('৳2,450.00')).toBeTruthy();
    expect(within(first).getByText('৳85.00')).toBeTruthy();
    const second = screen.getByRole('row', { name: /PT-2/ });
    expect(within(second).getByText('SIMULATED')).toBeTruthy();
    expect(screen.getByText('Showing 1–2 of 2 shipments')).toBeTruthy();

    await userEvent.click(screen.getByRole('tab', { name: /On the way/ }));
    await waitFor(() =>
      expect(api.shipments.list).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'picked_up,in_transit,out_for_delivery',
          page: 1,
          limit: 25,
        }),
      ),
    );
    await userEvent.type(screen.getByLabelText('Search shipments'), 'rina');
    await waitFor(() =>
      expect(api.shipments.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'rina' })),
    );
  });

  it('opens a shipment with its real history, order link and the actions the API allows', async () => {
    const api = shipmentsApi([row(1)]);
    mount(<ShipmentsScreen />, api);
    await userEvent.click(await screen.findByRole('row', { name: /PT-1/ }));
    const dialog = await screen.findByRole('complementary', { name: 'Shipment detail' });
    expect(await within(dialog).findByText('COD to collect')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: '#1001' })).toBeTruthy();
    // The timeline is built from the real events: provider words, our status, and what was not applied.
    const history = within(dialog).getByRole('list', { name: 'Shipment history' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(3);
    expect(within(history).getByText('Consignment created from OrderLoop')).toBeTruthy();
    expect(within(history).getByText('Not applied: it changed nothing here.')).toBeTruthy();
    // Only what the API says is possible is offered.
    expect(within(dialog).getByRole('button', { name: 'Check status now' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Cancel shipment' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Delivered' })).toBeNull();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Check status now' }));
    await waitFor(() => expect(api.shipments.refresh).toHaveBeenCalledWith(uuid(1)));
  });

  it('offers the simulate buttons only for a simulated shipment', async () => {
    const r = row(3, { simulated: true, provider: 'mock', environment: 'simulated' });
    const api = shipmentsApi([r]);
    api.shipments.get = vi.fn(async () =>
      detail(r, { actions: { ...detail(r).actions, canSimulate: true, canCancel: true } }),
    );
    setWidth(1000); // a tablet: the detail opens in a side sheet
    mount(<ShipmentsScreen />, api);
    await userEvent.click(await screen.findByRole('row', { name: /PT-3/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Shipment' });
    expect(await within(dialog).findByText('SIMULATED · not a real parcel')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Delivered' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel shipment' })).toBeTruthy();
  });

  it('says so when there are no shipments', async () => {
    const api = shipmentsApi([]);
    mount(<ShipmentsScreen />, api);
    expect(await screen.findByText('No shipments yet')).toBeTruthy();
  });
});

// ---- COD reconciliation ----------------------------------------------------------------------------------------------

const batch = (n: number, over: Partial<SettlementBatch> = {}): SettlementBatch => ({
  id: uuid(300 + n),
  provider: 'pathao',
  fileName: `file${n}.csv`,
  statementRef: `ST-${n}`,
  rowCount: 31,
  createdAt: '2026-10-16T08:00:00.000Z',
  createdByName: 'Anwar',
  reconciledAt: null,
  status: 'ready',
  counts: { matched: 31, unmatched: 0, ambiguous: 0, unallocated: 0, duplicate: 0, ignored: 0 },
  openDiscrepancies: 0,
  totals: { collectedMinor: 9_716_000, chargesMinor: 536_000, netMinor: 9_180_000 },
  expectedMinor: 9_842_000,
  differenceMinor: -126_000,
  ...over,
});

const outstanding: OutstandingCod = {
  asOf: '2026-10-18T06:00:00.000Z',
  deliveredExpectedMinor: 5_000_000,
  deliveredCollectedMinor: 4_000_000,
  outstandingMinor: 1_000_000,
  onTheWayMinor: 500_000,
  untrackedDeliveredCount: 0,
  untrackedDeliveredMinor: 0,
  byProvider: [],
  rows: [
    {
      orderId: uuid(701),
      orderNumber: 1701,
      provider: 'pathao',
      shipmentId: uuid(702),
      simulated: false,
      deliveredAt: '2026-10-10T06:00:00.000Z',
      ageDays: 8,
      expectedMinor: 1_000_000,
      collectedMinor: 0,
      outstandingMinor: 1_000_000,
      state: 'unpaid',
    },
  ],
  truncated: false,
};

const disc = (n: number, over: Partial<Discrepancy> = {}): Discrepancy => ({
  id: uuid(400 + n),
  type: 'short_paid',
  status: 'open',
  itemId: uuid(600 + n),
  shipmentId: null,
  orderId: uuid(800 + n),
  orderNumber: 1800 + n,
  expectedMinor: 302_000,
  actualMinor: 260_000,
  message: 'Reported 260.00 of 302.00',
  resolution: null,
  resolvedAt: null,
  createdAt: '2026-10-16T08:00:00.000Z',
  ...over,
});

const codApi = (over: Record<string, unknown> = {}) => ({
  finance: {
    batches: vi.fn(async () => [
      batch(1, { status: 'needs_attention', openDiscrepancies: 1 }),
      batch(2, { provider: 'steadfast', status: 'reconciled', differenceMinor: 0 }),
    ]),
    outstanding: vi.fn(async () => outstanding),
    discrepancies: vi.fn(async () => [disc(1)]),
    unmatched: vi.fn(async () => []),
    recheck: vi.fn(),
    importSettlement: vi.fn(),
    resolveDiscrepancy: vi.fn(async () => undefined),
    ...over,
  },
});

describe('COD reconciliation', () => {
  it('shows the KPIs from the real figures, and says delivered is not paid', async () => {
    mount(<CodReconciliationScreen />, codApi());
    expect(await screen.findByRole('heading', { name: 'COD reconciliation' })).toBeTruthy();
    expect(await screen.findByRole('group', { name: 'Outstanding COD: ৳10,000.00' })).toBeTruthy();
    // Two statements, 97,160 reported each.
    expect(screen.getByRole('group', { name: 'Reported by couriers: ৳1,94,320.00' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Courier charges: ৳10,720.00' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Paid out: ৳1,83,600.00' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Open discrepancies: 1' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Where the COD is' })).toBeTruthy();
    expect(screen.getByText(/Delivered is not paid/)).toBeTruthy();
  });

  it('lists settlements with their status in words, the difference, and filters by status', async () => {
    mount(<CodReconciliationScreen />, codApi());
    const attention = await screen.findByRole('row', { name: /ST-1/ });
    expect(within(attention).getByText('Needs attention')).toBeTruthy();
    expect(within(attention).getByText('-৳1,260.00')).toBeTruthy();
    expect(within(attention).getByRole('link', { name: 'ST-1' }).getAttribute('href')).toBe(
      '/cod/0197b0a0-0000-7000-8000-000000000301',
    );
    expect(within(screen.getByRole('row', { name: /ST-2/ })).getByText('Reconciled')).toBeTruthy();

    await userEvent.click(screen.getByRole('tab', { name: /^Reconciled/ }));
    expect(screen.queryByRole('row', { name: /ST-1/ })).toBeNull();
    expect(screen.getByRole('row', { name: /ST-2/ })).toBeTruthy();
  });

  it('lists outstanding orders and the open discrepancy with its actions', async () => {
    mount(<CodReconciliationScreen />, codApi());
    const order = await screen.findByRole('row', { name: /#1701/ });
    expect(within(order).getByText('No remittance')).toBeTruthy();
    expect(within(order).getAllByText('৳10,000.00').length).toBe(2);
    const table = await screen.findByRole('table', { name: 'Open discrepancies' });
    expect(within(table).getByText('Shortfall')).toBeTruthy();
    expect(within(table).getByRole('button', { name: 'Resolve' })).toBeTruthy();
    expect(within(table).getByRole('button', { name: 'Accept the loss' })).toBeTruthy();
  });

  it('hides the import and the discrepancy actions from a role that cannot use them', async () => {
    mount(<CodReconciliationScreen />, codApi(), 'MANAGER');
    await screen.findByRole('row', { name: /ST-1/ });
    expect(screen.queryByRole('button', { name: 'Import courier statement' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept the loss' })).toBeNull();
  });

  it('checks a statement without recording it, and shows the result', async () => {
    const importSettlement = vi.fn(async () => ({
      dryRun: true,
      alreadyImported: false,
      batchId: null,
      rows: 2,
      errors: [],
      fatal: null,
      counts: { matched: 2, unmatched: 0, ambiguous: 0, unallocated: 0, duplicate: 0, ignored: 0 },
      totals: { collectedMinor: 100_000, chargesMinor: 10_000, netMinor: 90_000 },
      discrepancies: 0,
    }));
    mount(<CodReconciliationScreen />, codApi({ importSettlement }));
    await userEvent.click(await screen.findByRole('button', { name: 'Import courier statement' }));
    const sheet = await screen.findByRole('dialog', { name: 'Import courier statement' });
    await userEvent.type(within(sheet).getByLabelText('Statement CSV'), 'a,b');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Check file' }));
    expect(await within(sheet).findByText('Check only. Nothing was recorded.')).toBeTruthy();
    expect(importSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, provider: 'steadfast', csv: 'a,b' }),
    );
  });

  it('shows an alert when the import fails', async () => {
    const importSettlement = vi.fn(async () => {
      throw new Error('The file could not be read');
    });
    mount(<CodReconciliationScreen />, codApi({ importSettlement }));
    await userEvent.click(await screen.findByRole('button', { name: 'Import courier statement' }));
    const sheet = await screen.findByRole('dialog', { name: 'Import courier statement' });
    await userEvent.type(within(sheet).getByLabelText('Statement CSV'), 'x');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Import' }));
    expect(await within(sheet).findByText('Import failed')).toBeTruthy();
  });
});

// ---- one settlement --------------------------------------------------------------------------------------------------

const item = (n: number, over: Partial<SettlementItem> = {}): SettlementItem => ({
  id: uuid(600 + n),
  batchId: uuid(301),
  lineNo: n,
  kind: 'cod',
  transactionId: null,
  consignmentId: `PT-${n}`,
  trackingCode: null,
  reference: null,
  phone: null,
  date: '2026-10-14',
  collectedMinor: 260_000,
  deliveryChargeMinor: 8_500,
  codFeeMinor: 2_600,
  returnChargeMinor: 0,
  otherDeductionMinor: 0,
  netMinor: 248_900,
  expectedMinor: 302_000,
  fileNetMinor: null,
  note: null,
  matchStatus: 'matched',
  matchMethod: 'consignment_id',
  matchNote: null,
  orderId: uuid(800 + n),
  orderNumber: 1800 + n,
  shipmentId: uuid(900 + n),
  duplicateOfId: null,
  discrepancies: [],
  ...over,
});

const detailBatch = (over: Partial<SettlementBatchDetail> = {}): SettlementBatchDetail => ({
  ...batch(1, { status: 'needs_attention', openDiscrepancies: 1 }),
  items: [item(1, { discrepancies: [disc(1)] }), item(2, { discrepancies: [disc(1)] })],
  issues: ['1 discrepancy about its lines is still open'],
  canReconcile: false,
  ...over,
});

const detailApi = (b: SettlementBatchDetail) => ({
  finance: {
    batch: vi.fn(async () => b),
    reconcile: vi.fn(async () => b),
    resolveDiscrepancy: vi.fn(async () => undefined),
    item: vi.fn(),
  },
});

describe('settlement detail', () => {
  it('disables Mark reconciled while an issue is open and explains why', async () => {
    mount(<SettlementDetailScreen id={uuid(301)} />, detailApi(detailBatch()));
    expect(await screen.findByRole('heading', { name: 'Settlement ST-1' })).toBeTruthy();
    expect(screen.getByText('This settlement cannot be reconciled yet')).toBeTruthy();
    expect(screen.getByText('1 discrepancy about its lines is still open')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Mark reconciled' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(screen.getByText('Needs attention')).toBeTruthy();
  });

  it('shows how the difference is calculated from the batch figures', async () => {
    mount(<SettlementDetailScreen id={uuid(301)} />, detailApi(detailBatch()));
    await screen.findByText('HOW THE DIFFERENCE IS CALCULATED');
    expect(screen.getByText('Expected COD of covered orders')).toBeTruthy();
    expect(screen.getByText('Reported for those orders')).toBeTruthy();
    // 98,420 expected, 1,260 short, so 97,160 reported.
    expect(screen.getAllByText('৳98,420.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('৳97,160.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Short by')).toBeTruthy();
  });

  it('lists each open discrepancy once, and resolves or accepts the loss with a reason', async () => {
    const api = detailApi(detailBatch());
    mount(<SettlementDetailScreen id={uuid(301)} />, api);
    await screen.findByText('Review discrepancy');
    // Two lines share one discrepancy: one block.
    expect(await screen.findAllByRole('button', { name: 'Accept the loss' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Accept the loss' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept this shortfall as a loss' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByText('Say why (at least 3 characters)')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Courier confirmed the loss');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(api.finance.resolveDiscrepancy).toHaveBeenCalledWith(uuid(401), {
        action: 'waive',
        note: 'Courier confirmed the loss',
      }),
    );
  });

  it('enables Mark reconciled when nothing is open and reconciles on press', async () => {
    const clean = detailBatch({
      status: 'ready',
      issues: [],
      canReconcile: true,
      openDiscrepancies: 0,
      items: [item(1)],
    });
    const api = detailApi(clean);
    mount(<SettlementDetailScreen id={uuid(301)} />, api);
    expect(await screen.findByText('No open discrepancies')).toBeTruthy();
    expect(screen.getByText('Nothing is unmatched or in doubt')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Mark reconciled' });
    expect(button.getAttribute('aria-disabled')).not.toBe('true');
    await userEvent.click(button);
    await waitFor(() => expect(api.finance.reconcile).toHaveBeenCalledWith(uuid(301)));
  });

  it('does not offer reconcile or discrepancy actions to a role that may only read', async () => {
    mount(<SettlementDetailScreen id={uuid(301)} />, detailApi(detailBatch()), 'MANAGER');
    await screen.findByRole('heading', { name: 'Settlement ST-1' });
    expect(screen.queryByRole('button', { name: 'Mark reconciled' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept the loss' })).toBeNull();
  });
});
