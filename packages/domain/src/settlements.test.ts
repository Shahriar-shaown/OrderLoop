import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  calculateProfit,
  cashPosition,
  decideMatch,
  parseSettlementAmount,
  parseSettlementCsv,
  parseSettlementDate,
  settlementItemKeyMaterial,
  settlementNet,
  type MatchCandidate,
  type SettlementRow,
} from './settlements.js';

const HEAD =
  'transaction_id,consignment_id,tracking_code,reference,phone,date,type,collected,delivery_charge,cod_fee,return_charge,other_deduction,net,note';
const csv = (...lines: string[]) => [HEAD, ...lines].join('\n');

describe('reading amounts and dates', () => {
  it('reads taka the way people write it, exactly', () => {
    expect(parseSettlementAmount('1,250.50')).toBe(125_050);
    expect(parseSettlementAmount('৳1250')).toBe(125_000);
    expect(parseSettlementAmount('Tk 850')).toBe(85_000);
    expect(parseSettlementAmount('BDT 99.5')).toBe(9_950);
    expect(parseSettlementAmount('0.29')).toBe(29); // a float would give 28.999...
    expect(parseSettlementAmount('')).toBe(0);
    for (const bad of ['-5', '1.234', 'abc', '1e3', '12,34.5.6'])
      expect(parseSettlementAmount(bad), bad).toBeNull();
  });
  it('reads dates day first and refuses ones that do not exist', () => {
    expect(parseSettlementDate('2026-10-05')).toBe('2026-10-05');
    expect(parseSettlementDate('5/10/2026')).toBe('2026-10-05');
    expect(parseSettlementDate('05-10-2026')).toBe('2026-10-05');
    for (const bad of ['2026-02-30', '31/04/2026', 'yesterday', '2026/10/05', ''])
      expect(parseSettlementDate(bad), bad).toBeNull();
  });
  it('every whole-paisa amount survives a round trip through text', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), (paisa) => {
        const text = `${Math.floor(paisa / 100)}.${String(paisa % 100).padStart(2, '0')}`;
        expect(parseSettlementAmount(text)).toBe(paisa);
      }),
    );
  });
});

describe('reading a settlement file', () => {
  it('reads every line and works out each one’s net', () => {
    const r = parseSettlementCsv(
      csv(
        't1,C1,,OL-1001,01712345678,2026-10-05,cod,1060,60,10.60,0,0,989.40,',
        ',,,OL-1002,,2026-10-05,return,0,0,0,50,0,,returned parcel',
        ',,,,,2026-10-06,adjustment,0,0,0,0,25,,monthly fee',
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({
      collectedMinor: 106_000,
      codFeeMinor: 1_060,
      fileNetMinor: 98_940,
      phone: '+8801712345678',
    });
    expect(settlementNet(r.rows[0]!)).toBe(98_940);
    expect(settlementNet(r.rows[1]!)).toBe(-5_000); // a return fee with no cash is a negative net
    expect(r.rows[2]).toMatchObject({ kind: 'adjustment', consignmentId: null });
  });
  it('refuses the whole file, naming each bad line, rather than guess', () => {
    const r = parseSettlementCsv(
      csv(
        ',C1,,,,2026-10-05,cod,1060,0,0,0,0,,',
        ',C2,,,,not-a-date,cod,100,0,0,0,0,,',
        ',C3,,,,2026-10-05,cod,-5,0,0,0,0,,',
        ',,,,,2026-10-05,cod,100,0,0,0,0,,',
        ',C5,,,,2026-10-05,refund,100,0,0,0,0,,',
        ',C6,,,,2026-10-05,return,100,0,0,0,0,,',
      ),
    );
    expect(r.rows).toEqual([]);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7]);
  });
  it('refuses unknown columns, duplicate columns and a file with nothing to match on', () => {
    expect(parseSettlementCsv('date,collected,bogus\n2026-10-05,1,2').fatal).toMatch(
      /Unknown column/,
    );
    expect(parseSettlementCsv('date,date,reference\n2026-10-05,2026-10-05,1').fatal).toMatch(
      /more than once/,
    );
    expect(parseSettlementCsv('date,collected\n2026-10-05,1').fatal).toMatch(/at least one of/);
    expect(parseSettlementCsv('').fatal).toMatch(/empty/);
  });
  it('gives the same key to the same line and a different one to any change', () => {
    const base: SettlementRow = {
      line: 2,
      transactionId: null,
      consignmentId: 'C1',
      trackingCode: null,
      reference: 'OL-1',
      phone: null,
      date: '2026-10-05',
      kind: 'cod',
      collectedMinor: 100,
      deliveryChargeMinor: 0,
      codFeeMinor: 0,
      returnChargeMinor: 0,
      otherDeductionMinor: 0,
      fileNetMinor: null,
      note: null,
    };
    const key = (r: Partial<SettlementRow>) =>
      settlementItemKeyMaterial('pathao', { ...base, ...r });
    expect(key({ line: 99 })).toBe(key({})); // where it sits in the file is not part of what it says
    expect(key({ note: 'x' })).not.toBe(key({})); // two identical fees for different reasons are two lines
    expect(key({ note: ' X ' })).toBe(key({ note: 'x' }));
    expect(key({ phone: '+8801712345678' })).not.toBe(key({}));
    expect(key({ consignmentId: 'c1' })).toBe(key({})); // case does not matter
    for (const change of [
      { collectedMinor: 101 },
      { date: '2026-10-06' },
      { kind: 'return' as const },
      { codFeeMinor: 1 },
    ])
      expect(key(change)).not.toBe(key({}));
    expect(settlementItemKeyMaterial('steadfast', base)).not.toBe(
      settlementItemKeyMaterial('pathao', base),
    );
    expect(key({ transactionId: 'TX-1', collectedMinor: 5 })).toBe(
      key({ transactionId: 'tx-1', collectedMinor: 9 }),
    ); // the courier's own id wins
  });
});

describe('settlement file limits and line numbers', () => {
  it('refuses an amount above what the database holds, as a line error', () => {
    expect(parseSettlementAmount('20000000')).toBe(2_000_000_000);
    expect(parseSettlementAmount('20000000.01')).toBeNull();
    const r = parseSettlementCsv(csv(',,,OL-1,,2026-10-05,cod,99999999999,0,0,0,0,,'));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/collected/);
  });
  it('refuses a line whose net does not fit the database column', () => {
    const r = parseSettlementCsv(
      csv(',,,OL-1,,2026-10-05,adjustment,0,20000000,20000000,20000000,0,,'),
    );
    expect(r.rows).toEqual([]);
    expect(r.errors).toEqual([{ line: 2, message: expect.stringMatching(/net/) }]);
  });
  it('requires collected on a cod line, but not on a return or adjustment', () => {
    const noCollected = parseSettlementCsv(csv(',C1,,,,2026-10-05,cod,,60,0,0,0,,'));
    expect(noCollected.errors).toEqual([{ line: 2, message: expect.stringMatching(/collected/) }]);
    const noColumn = parseSettlementCsv('consignment_id,date\nC1,2026-10-05');
    expect(noColumn.errors).toHaveLength(1);
    expect(parseSettlementCsv(csv(',C1,,,,2026-10-05,cod,0,60,0,0,0,,')).errors).toEqual([]);
    expect(parseSettlementCsv(csv(',C1,,,,2026-10-05,return,,0,0,50,0,,')).errors).toEqual([]);
  });
  it('reports the physical line, past blank lines and multi-line quoted fields', () => {
    const r = parseSettlementCsv(
      [
        HEAD,
        ',,,OL-1,,2026-10-05,cod,0,0,0,0,0,,"two\nline note"',
        '',
        ',,,OL-2,,not-a-date,cod,0,0,0,0,0,,',
      ].join('\n'),
    );
    expect(r.errors).toEqual([{ line: 5, message: expect.stringMatching(/not a date/) }]);
  });
});

describe('matching a line to a parcel', () => {
  const cands: MatchCandidate[] = [
    {
      shipmentId: 's1',
      orderId: 'o1',
      orderNumber: 1001,
      consignmentId: 'C1',
      trackingCode: 'T1',
      reference: 'OL-1001',
      shipPhone: '01712345678',
    },
    {
      shipmentId: 's2',
      orderId: 'o2',
      orderNumber: 1002,
      consignmentId: 'C2',
      trackingCode: null,
      reference: 'OL-1002',
      shipPhone: '01811111111',
    },
    {
      shipmentId: 's3a',
      orderId: 'o3',
      orderNumber: 1003,
      consignmentId: null,
      trackingCode: null,
      reference: 'OL-1003',
      shipPhone: '01911111111',
    },
    {
      shipmentId: 's3b',
      orderId: 'o3',
      orderNumber: 1003,
      consignmentId: null,
      trackingCode: null,
      reference: 'OL-1003-2',
      shipPhone: '01911111111',
    },
  ];
  const row = (o: Partial<SettlementRow>): SettlementRow => ({
    line: 2,
    transactionId: null,
    consignmentId: null,
    trackingCode: null,
    reference: null,
    phone: null,
    date: '2026-10-05',
    kind: 'cod',
    collectedMinor: 0,
    deliveryChargeMinor: 0,
    codFeeMinor: 0,
    returnChargeMinor: 0,
    otherDeductionMinor: 0,
    fileNetMinor: null,
    note: null,
    ...o,
  });
  it('matches on the courier’s id, the tracking code or our reference, in that order of trust', () => {
    expect(decideMatch(row({ consignmentId: 'c1' }), cands)).toMatchObject({
      outcome: 'matched',
      method: 'consignment_id',
      shipmentId: 's1',
    });
    expect(decideMatch(row({ trackingCode: 'T1' }), cands)).toMatchObject({
      outcome: 'matched',
      method: 'tracking_code',
      shipmentId: 's1',
    });
    expect(decideMatch(row({ reference: 'ol-1002' }), cands)).toMatchObject({
      outcome: 'matched',
      method: 'reference',
      shipmentId: 's2',
    });
    expect(decideMatch(row({ consignmentId: 'C1', reference: 'OL-1001' }), cands)).toMatchObject({
      outcome: 'matched',
      method: 'consignment_id',
    });
  });
  it('never guesses when identifiers disagree', () => {
    expect(decideMatch(row({ consignmentId: 'C1', reference: 'OL-1002' }), cands)).toMatchObject({
      outcome: 'ambiguous',
    });
  });
  it('uses a bare order number only when nothing stronger is given, and checks the phone if there is one', () => {
    expect(decideMatch(row({ reference: '#1002' }), cands)).toMatchObject({
      outcome: 'matched',
      method: 'order_number',
      shipmentId: 's2',
    });
    expect(decideMatch(row({ reference: '1002', phone: '+8801811111111' }), cands)).toMatchObject({
      outcome: 'matched',
    });
    expect(decideMatch(row({ reference: '1002', phone: '+8801999999999' }), cands)).toMatchObject({
      outcome: 'ambiguous',
    });
    expect(decideMatch(row({ reference: '1003' }), cands)).toMatchObject({ outcome: 'ambiguous' }); // two parcels for that order
  });
  it('does not fall back to the order number when a strong id was given but not found', () => {
    expect(decideMatch(row({ consignmentId: 'NOPE', reference: '1002' }), cands)).toMatchObject({
      outcome: 'unmatched',
    });
    expect(decideMatch(row({ trackingCode: 'NOPE', reference: '#1002' }), cands)).toMatchObject({
      outcome: 'unmatched',
    });
    expect(decideMatch(row({ reference: 'OL-9999' }), cands)).toMatchObject({
      outcome: 'unmatched',
    });
  });
  it('is ambiguous when a found strong id contradicts the reference', () => {
    expect(decideMatch(row({ consignmentId: 'C1', reference: '1002' }), cands)).toMatchObject({
      outcome: 'ambiguous',
    });
    expect(decideMatch(row({ consignmentId: 'C1', reference: 'OL-9999' }), cands)).toMatchObject({
      outcome: 'ambiguous',
    });
    expect(decideMatch(row({ consignmentId: 'C1', reference: '#1001' }), cands)).toMatchObject({
      outcome: 'matched',
    });
  });
  it('never matches on a phone number alone, or on an amount', () => {
    expect(
      decideMatch(row({ phone: '+8801712345678', collectedMinor: 106_000 }), cands),
    ).toMatchObject({ outcome: 'unmatched' });
    expect(decideMatch(row({ consignmentId: 'NOPE' }), cands)).toMatchObject({
      outcome: 'unmatched',
    });
    expect(decideMatch(row({ reference: 'OL-9999' }), cands)).toMatchObject({
      outcome: 'unmatched',
    });
    expect(decideMatch(row({ reference: 'INV-77' }), cands)).toMatchObject({
      outcome: 'unmatched',
    });
  });
});

describe('what cash is owed', () => {
  const pos = (
    status: Parameters<typeof cashPosition>[0]['status'],
    cod: number,
    collected: number,
  ) => cashPosition({ status, codAmountMinor: cod, collectedMinor: collected });
  it('a delivered order with no remittance is outstanding: delivery is not proof of cash', () => {
    expect(pos('delivered', 100_000, 0)).toMatchObject({
      state: 'unpaid',
      outstandingMinor: 100_000,
    });
  });
  it('partial and full remittance', () => {
    expect(pos('delivered', 100_000, 40_000)).toMatchObject({
      state: 'partial',
      outstandingMinor: 60_000,
    });
    expect(pos('delivered', 100_000, 100_000)).toMatchObject({
      state: 'paid',
      outstandingMinor: 0,
    });
    expect(pos('delivered', 100_000, 110_000)).toMatchObject({
      state: 'overpaid',
      excessMinor: 10_000,
      outstandingMinor: 0,
    });
  });
  it('an order that needs no cash is paid, not outstanding', () => {
    expect(pos('delivered', 0, 0)).toMatchObject({ state: 'paid', outstandingMinor: 0 });
  });
  it('orders not delivered owe nothing yet, and cash reported for them is flagged', () => {
    expect(pos('in_transit', 100_000, 0)).toMatchObject({
      state: 'awaiting_delivery',
      outstandingMinor: 0,
    });
    expect(pos('in_transit', 100_000, 100_000)).toMatchObject({
      state: 'cash_before_delivery',
      outstandingMinor: 0,
    });
    for (const s of ['cancelled', 'returned', 'return_requested'] as const) {
      expect(pos(s, 100_000, 0)).toMatchObject({ state: 'not_due', outstandingMinor: 0 });
      expect(pos(s, 100_000, 5_000)).toMatchObject({
        state: 'cash_on_closed_order',
        excessMinor: 5_000,
      });
    }
  });
  it('outstanding is never negative and collected + outstanding covers the expectation of a delivered order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (cod, collected) => {
          const p = pos('delivered', cod, collected);
          expect(p.outstandingMinor).toBeGreaterThanOrEqual(0);
          expect(Math.min(collected, cod) + p.outstandingMinor).toBe(cod);
        },
      ),
    );
  });
});

describe('profit', () => {
  it('adds up income and takes off every cost, exactly', () => {
    const r = calculateProfit({
      goodsRevenueMinor: 1_000_000,
      deliveryBilledMinor: 12_000,
      cogsMinor: 600_000,
      courierChargesMinor: 25_050,
      manualCostsMinor: 10_000,
      writtenOffMinor: 5_000,
    });
    expect(r).toEqual({
      estimatedProfitMinor: 371_950,
      withheldReason: null,
      incomeMinor: 1_012_000,
      costsMinor: 640_050,
    });
  });
  it('can be a loss', () => {
    expect(
      calculateProfit({
        goodsRevenueMinor: 100,
        deliveryBilledMinor: 0,
        cogsMinor: 0,
        courierChargesMinor: 500,
        manualCostsMinor: 0,
        writtenOffMinor: 0,
      }).estimatedProfitMinor,
    ).toBe(-400);
  });
  it('is withheld, with the reason, when the cost of goods is unknown', () => {
    const r = calculateProfit({
      goodsRevenueMinor: 1,
      deliveryBilledMinor: 0,
      cogsMinor: null,
      courierChargesMinor: 0,
      manualCostsMinor: 0,
      writtenOffMinor: 0,
    });
    expect(r.estimatedProfitMinor).toBeNull();
    expect(r.withheldReason).toMatch(/no cost price/);
  });
  it('income minus costs always equals profit', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000_000 }), { minLength: 6, maxLength: 6 }),
        ([a, b, c, d, e, f]) => {
          const r = calculateProfit({
            goodsRevenueMinor: a!,
            deliveryBilledMinor: b!,
            cogsMinor: c!,
            courierChargesMinor: d!,
            manualCostsMinor: e!,
            writtenOffMinor: f!,
          });
          expect(r.estimatedProfitMinor).toBe(r.incomeMinor - r.costsMinor!);
        },
      ),
    );
  });
});
