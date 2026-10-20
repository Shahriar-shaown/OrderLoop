import { describe, expect, it } from 'vitest';
import { parseOrdersCsv } from './orders-import.js';

const H =
  'order_ref,customer_name,phone,address_line,area,district,division,sku,quantity,unit_price,line_discount,discount,delivery_charge,advance_paid,source,notes\n';

describe('parseOrdersCsv', () => {
  it('groups lines by order_ref into orders, normalising phone, SKU and money', () => {
    const csv =
      H +
      'A1,Rina Akter,01712-345678,House 5 Road 3,Dhanmondi,Dhaka,dhaka,tee-red,2,850.50,,100,60,200,Facebook,Eid offer\n' +
      'A1,,,,,,,mug-1,1,,50,,,,,\n' +
      'B7,Karim,+8801812345678,Village X,Sadar,Cumilla,Chattogram,TEE-RED,1,,,,,,phone call,\n';
    const r = parseOrdersCsv(csv);
    expect(r.fatal).toBeNull();
    expect(r.errors).toEqual([]);
    expect(r.orders).toHaveLength(2);
    const a = r.orders[0]!;
    expect(a).toMatchObject({
      ref: 'A1',
      row: 2,
      customerName: 'Rina Akter',
      phone: '+8801712345678',
      division: 'Dhaka',
      discountMinor: 10000,
      deliveryChargeMinor: 6000,
      advancePaidMinor: 20000,
      source: 'facebook',
      notes: 'Eid offer',
    });
    expect(a.items).toEqual([
      { row: 2, sku: 'TEE-RED', quantity: 2, unitPriceMinor: 85050, discountMinor: 0 },
      { row: 3, sku: 'MUG-1', quantity: 1, unitPriceMinor: null, discountMinor: 5000 },
    ]);
    expect(r.orders[1]).toMatchObject({ source: 'phone_call', phone: '+8801812345678' });
  });

  it('leaves an order out whole when any of its lines is bad, and says which line', () => {
    const csv =
      H +
      'A1,Rina,01712345678,Road 3,Dhanmondi,Dhaka,Dhaka,TEE,1,,,,,,,\n' +
      'A1,,,,,,,MUG,zero,,,,,,,\n' +
      'B1,Karim,01812345678,Road 9,Sadar,Cumilla,Chattogram,TEE,1,,,,,,,\n';
    const r = parseOrdersCsv(csv);
    expect(r.orders.map((o) => o.ref)).toEqual(['B1']);
    expect(r.errors).toEqual([{ row: 3, message: 'quantity must be a whole number of 0 or more' }]);
  });

  it('reports bad phone, division, source, price, postal code and contradictions', () => {
    const csv =
      H +
      'X,Rina,12345,Road 3,Dhanmondi,Dhaka,Narnia,TEE,1,12.345,,,,,telepathy,\n' +
      'Y,Rina,01712345678,Road 3,Dhanmondi,Dhaka,Dhaka,TEE,1,,,,,,,\n' +
      'Y,Someone Else,,,,,,MUG,1,,,,,,,\n';
    const msgs = parseOrdersCsv(csv)
      .errors.map((e) => e.message)
      .join('\n');
    expect(msgs).toMatch(/phone is not a Bangladeshi mobile number/);
    expect(msgs).toMatch(/division must be one of/);
    expect(msgs).toMatch(/source must be one of/);
    expect(msgs).toMatch(/unit_price must be a non-negative amount with at most 2 decimals/);
    expect(msgs).toMatch(/customer_name differs between the lines of order Y/);
  });

  it('requires an order_ref, rejects repeated SKUs within an order, and never reads a total', () => {
    const csv =
      H +
      ',Rina,01712345678,Road,Area,Dhaka,Dhaka,TEE,1,,,,,,,\n' +
      'Z,Rina,01712345678,Road,Area,Dhaka,Dhaka,TEE,1,,,,,,,\n' +
      'Z,,,,,,,tee,2,,,,,,,\n';
    const r = parseOrdersCsv(csv);
    expect(r.errors.map((e) => e.message).join('\n')).toMatch(/order_ref is required/);
    expect(r.errors.map((e) => e.message).join('\n')).toMatch(/sku TEE appears twice in order Z/);
    expect(parseOrdersCsv('order_ref,total\nA,100\n').fatal).toMatch(/Unknown column/);
  });

  it('refuses files it cannot read, with the reason', () => {
    expect(parseOrdersCsv('').fatal).toBeTruthy();
    expect(parseOrdersCsv('order_ref,phone\nA,1\n').fatal).toMatch(/Missing required column/);
    expect(parseOrdersCsv(H).fatal).toMatch(/no rows/);
    expect(
      parseOrdersCsv(
        'order_ref,customer_name,phone,address_line,area,district,division,sku,quantity,sku\n',
      ).fatal,
    ).toMatch(/more than once/);
    expect(
      parseOrdersCsv(
        'order_ref,customer_name,phone,address_line,area,district,division,sku,quantity\n"A,1\n',
      ).fatal,
    ).toBeTruthy();
  });

  it('reports the physical line of a bad row, past blank lines and multi-line notes', () => {
    const r = parseOrdersCsv(
      H +
        'A1,Rina Akter,01712-345678,House 5,Dhanmondi,Dhaka,Dhaka,tee-red,1,,,,,,,"line one\nline two"\n' +
        '\n' +
        'A2,Karim,01712-345679,House 6,Dhanmondi,Dhaka,Dhaka,tee-red,x,,,,,,,\n',
    );
    expect(r.orders.map((o) => [o.ref, o.row])).toEqual([['A1', 2]]);
    expect(r.orders[0]!.notes).toBe('line one\nline two');
    expect(r.errors).toEqual([{ row: 5, message: 'quantity must be a whole number of 0 or more' }]);
  });
  it('accepts common spellings of a division and stores the canonical one', () => {
    const r = parseOrdersCsv(
      H + 'A1,Rina Akter,01712-345678,House 5,Pahartali,Chittagong,Chittagong,tee-red,1,,,,,,,\n',
    );
    expect(r.errors).toEqual([]);
    expect(r.orders[0]!.division).toBe('Chattogram');
  });
});
