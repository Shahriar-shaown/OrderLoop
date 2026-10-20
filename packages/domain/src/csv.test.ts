import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv, parseCsvRecords } from './csv.js';

describe('parseCsvRecords', () => {
  it('reports the physical line each record starts on, past blank lines and quoted line breaks', () => {
    const records = parseCsvRecords('a,b\n\n"x\ny",1\r\n\r\nlast,2\n');
    expect(records.map((r) => r.line)).toEqual([1, 3, 6]);
    expect(records[1]!.fields).toEqual(['x\ny', '1']);
  });
  it('counts a lone CR as a line break and ignores a leading BOM', () => {
    expect(parseCsvRecords('\ufeffa\rb\r\rc').map((r) => r.line)).toEqual([1, 2, 4]);
  });
});

describe('parseCsv', () => {
  it('parses plain rows with LF and CRLF, skipping blank lines', () => {
    expect(parseCsv('a,b\n1,2\r\n\r\n3,4\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });
  it('handles quotes, escaped quotes, commas and line breaks inside quotes', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"line1\nline2",z')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['line1\nline2', 'z'],
    ]);
  });
  it('keeps empty fields and a trailing empty field', () => {
    expect(parseCsv('a,,c\n,,')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });
  it('strips a UTF-8 BOM and handles non-Latin text', () => {
    expect(parseCsv('﻿নাম,sku\nটি-শার্ট,A1')).toEqual([
      ['নাম', 'sku'],
      ['টি-শার্ট', 'A1'],
    ]);
  });
  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,b\n"oops,1')).toThrow(CsvError);
  });
  it('round-trips arbitrary field values through a quoting writer', () => {
    const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
    fc.assert(
      fc.property(
        fc.array(
          fc.array(
            fc.string({ unit: 'binary' }).filter((s) => s !== ''),
            { minLength: 1, maxLength: 4 },
          ),
          { minLength: 1, maxLength: 6 },
        ),
        (table) => {
          const width = Math.max(...table.map((r) => r.length));
          const padded = table.map((r) => [...r, ...Array(width - r.length).fill('x')]);
          const csv = padded.map((r) => r.map(quote).join(',')).join('\r\n');
          expect(parseCsv(csv)).toEqual(padded);
        },
      ),
      { numRuns: 200 },
    );
  });
});
