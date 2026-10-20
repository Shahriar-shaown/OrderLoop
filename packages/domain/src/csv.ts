export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

export interface CsvRecord {
  fields: string[];
  /** Physical line of the file where the record starts (the first line is 1), as an editor would show it. */
  line: number;
}

/**
 * Parse RFC 4180 CSV into rows of fields: quoted fields, doubled quotes, commas and line breaks inside quotes,
 * CRLF or LF, optional BOM. Blank lines are skipped. Throws CsvError on an unterminated quote.
 */
export function parseCsv(input: string): string[][] {
  return parseCsvRecords(input).map((r) => r.fields);
}

/** Like `parseCsv`, but says on which physical line each record starts, so errors point at the right line. */
export function parseCsvRecords(input: string): CsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: CsvRecord[] = [];
  let row: string[] = [];
  let line = 1;
  let startLine = 1;
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push({ fields: row, line: startLine });
    row = [];
  };
  // A line break inside a quoted field moves the line count on, but not the line the record started on.
  const isBreak = (i: number) => text[i] === '\n' || (text[i] === '\r' && text[i + 1] !== '\n');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
        if (isBreak(i)) line++;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRow();
      startLine = ++line;
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
      startLine = ++line;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new CsvError('Unterminated quoted field');
  if (fieldStarted || field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Write rows as CSV (RFC 4180: CRLF line ends, quotes doubled). A cell that starts with = + - @ tab or CR would be run as a
 * formula by spreadsheet programs, so such text cells get a leading apostrophe ("CSV injection"). Numbers pass through as
 * given: pass them as numbers, not strings, so legitimate negatives like -5 are not altered.
 */
export function toCsv(rows: readonly (readonly (string | number | null)[])[]): string {
  const cell = (value: string | number | null): string => {
    if (value === null) return '';
    let text = String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
