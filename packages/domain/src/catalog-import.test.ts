import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, parseCatalogCsv } from './catalog-import.js';
import { nameKey, normalizeSku } from './sku.js';

const HEADER =
  'product_name,sku,price,category,unit,variant_name,cost,reorder_point,opening_stock,location';

describe('sku and names', () => {
  it('normalises SKUs and rejects bad ones', () => {
    expect(normalizeSku('  tee-red.m_1 ')).toBe('TEE-RED.M_1');
    for (const bad of ['', '-x', 'a b', 'a/b', 'x'.repeat(65), 'টি'])
      expect(normalizeSku(bad), bad).toBeNull();
  });
  it('builds a case- and spacing-insensitive name key', () => {
    expect(nameKey('  Cotton   T-Shirt ')).toBe('cotton t-shirt');
  });
});

describe('parseCatalogCsv', () => {
  it('turns valid rows into normalised import rows, with money as paisa', () => {
    const r = parseCatalogCsv(
      `${HEADER}\nT-Shirt,tee-r-m,1250.50,Shirts,pcs,Red / M,800,5,20,Main\nT-Shirt,tee-r-l,1250.5,Shirts,pcs,Red / L,,,,`,
    );
    expect(r.fatal).toBeNull();
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      row: 2,
      productName: 'T-Shirt',
      sku: 'TEE-R-M',
      priceMinor: 125050,
      costMinor: 80000,
      reorderPoint: 5,
      openingStock: 20,
      location: 'Main',
      category: 'Shirts',
    });
    expect(r.rows[1]).toMatchObject({
      row: 3,
      sku: 'TEE-R-L',
      priceMinor: 125050,
      costMinor: null,
      openingStock: 0,
    });
  });

  it('applies defaults when optional columns are absent', () => {
    const r = parseCatalogCsv('product_name,sku,price\nMug,MUG-1,300');
    expect(r.rows[0]).toMatchObject({
      unit: 'pcs',
      category: null,
      variantName: '',
      reorderPoint: 0,
      openingStock: 0,
      location: null,
      costMinor: null,
    });
  });

  it('reports file-level problems as fatal', () => {
    expect(parseCatalogCsv('').fatal).toMatch(/empty/);
    expect(parseCatalogCsv('product_name,sku\nA,B').fatal).toMatch(/Missing required.*price/);
    expect(parseCatalogCsv('product_name,sku,price,prize\nA,B,1,2').fatal).toMatch(
      /Unknown column.*prize/,
    );
    expect(parseCatalogCsv('product_name,sku,price,sku\nA,B,1,2').fatal).toMatch(/more than once/);
    expect(parseCatalogCsv('product_name,sku,price').fatal).toMatch(/no rows/);
    expect(parseCatalogCsv('a,b\n"unterminated').fatal).toMatch(/Unterminated/);
    expect(
      parseCatalogCsv('product_name,sku,price\n' + 'A,S1,1\n'.repeat(IMPORT_LIMITS.maxRows + 1))
        .fatal,
    ).toMatch(/more than/);
    expect(
      parseCatalogCsv('product_name,sku,price\nA,S1,' + '1'.repeat(IMPORT_LIMITS.maxBytes)).fatal,
    ).toMatch(/larger than/);
  });

  it('collects row errors without losing the good rows', () => {
    const r = parseCatalogCsv(
      [
        'product_name,sku,price,unit,opening_stock,cost',
        'Good,G-1,10,,,',
        ',NOPE-1,10,,,',
        'BadSku,bad sku,10,,,',
        'BadPrice,B-2,12.345,,,',
        'NegPrice,B-3,-1,,,',
        'BadUnit,B-4,10,furlong,,',
        'BadStock,B-5,10,,1.5,',
        'HugeStock,B-6,10,,2000000,',
        'Good,G-1,10,,,',
        'Extra,E-1,10,,,,,surplus',
      ].join('\n'),
    );
    expect(r.rows.map((x) => x.sku)).toEqual(['G-1']);
    const byRow = Object.fromEntries(r.errors.map((e) => [e.row, e.message]));
    expect(byRow[3]).toMatch(/product_name is required/);
    expect(byRow[4]).toMatch(/sku is invalid/);
    expect(byRow[5]).toMatch(/price must be/);
    expect(byRow[6]).toMatch(/price must be/);
    expect(byRow[7]).toMatch(/unit must be one of/);
    expect(byRow[8]).toMatch(/opening_stock must be a whole number/);
    expect(byRow[9]).toMatch(/opening_stock must be at most/);
    expect(byRow[10]).toMatch(/repeated/);
    expect(byRow[11]).toMatch(/more fields than the header/);
    expect(r.totalRows).toBe(10);
  });

  it('requires rows of one product to agree on unit and category', () => {
    const r = parseCatalogCsv(
      'product_name,sku,price,unit,category\nRice,R-1,50,kg,Grocery\nRice,R-2,60,pcs,Grocery\nrice,R-3,70,kg,Grocery',
    );
    expect(r.rows.map((x) => x.sku)).toEqual(['R-1', 'R-3']);
    expect(r.errors).toEqual([
      expect.objectContaining({ row: 3, message: expect.stringMatching(/differs from line 2/) }),
    ]);
  });

  it('is not tripped by hostile content: formulas and markup are kept as plain text, never executed or stripped silently', () => {
    const r = parseCatalogCsv(
      'product_name,sku,price\n"=HYPERLINK(""http://evil"")",X-1,10\n"<script>alert(1)</script>",X-2,10',
    );
    expect(r.rows.map((x) => x.productName)).toEqual([
      '=HYPERLINK("http://evil")',
      '<script>alert(1)</script>',
    ]);
  });
});

describe('contract parity', () => {
  it('the SKU rule in @orderloop/contracts accepts and rejects exactly what normalizeSku does, and normalises identically', async () => {
    const { Sku } = await import('@orderloop/contracts');
    const samples = [
      'tee-red-m',
      ' TEE-1 ',
      'a',
      'A.B_C-9',
      '-x',
      '',
      'a b',
      'a/b',
      'x'.repeat(64),
      'x'.repeat(65),
      'টি',
      'ÄB',
      '1',
      'a\nb',
      'sku#1',
      '.dot',
      'UPPER',
    ];
    for (const sample of samples) {
      const domain = normalizeSku(sample);
      const contract = Sku.safeParse(sample);
      expect(contract.success, JSON.stringify(sample)).toBe(domain !== null);
      if (domain !== null && contract.success) expect(contract.data).toBe(domain);
    }
  });
});
