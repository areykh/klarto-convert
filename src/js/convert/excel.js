// Excel reading and writing on top of SheetJS Community Edition. The SheetJS
// module is passed in (XLSX), so these stay plain functions for Node tests.
import { ConvertError } from './errors.js';
import { formatDateCell, cellRef, MAX_ROWS, MAX_COLS, MAX_CELL_TEXT } from './cells.js';

const ERRORS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A', 0x2b: '#GETTING_DATA' };

// Which spreadsheet container the bytes are: 'zip' (xlsx, xlsm, ods), 'ole'
// (xls) or null.
export function sniffWorkbook(b) {
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'ole';
  return null;
}

export function readWorkbook(XLSX, bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length === 0) throw new ConvertError('input.empty');
  const kind = sniffWorkbook(b);
  if (!kind) throw new ConvertError('excel.notWorkbook');
  let wb;
  try {
    wb = XLSX.read(b, { type: 'array', dense: true, cellNF: true, cellText: false, cellDates: false, cellFormula: false, cellHTML: false, cellStyles: false });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/password-protected|ECMA-376 Encrypted|Unrecognized encryption/i.test(msg)) throw new ConvertError('excel.encrypted');
    throw new ConvertError('excel.unreadable', { detail: msg.slice(0, 200) });
  }
  if (!wb.SheetNames || wb.SheetNames.length === 0) throw new ConvertError('excel.noSheets');
  return wb;
}

export function sheetList(XLSX, wb) {
  const meta = (wb.Workbook && wb.Workbook.Sheets) || [];
  return wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name];
    let rows = 0;
    let cols = 0;
    if (ws && ws['!ref']) {
      const r = XLSX.utils.decode_range(ws['!ref']);
      rows = r.e.r + 1;
      cols = r.e.c + 1;
    }
    return { name, rows, cols, hidden: !!(meta[i] && meta[i].Hidden) };
  });
}

function cellValue(XLSX, cell, date1904) {
  if (!cell) return null;
  switch (cell.t) {
    case 'n':
      if (cell.z && cell.z !== 'General' && XLSX.SSF.is_date(cell.z)) return formatDateCell(cell.v, cell.z, date1904);
      return cell.v;
    case 's':
    case 'str':
      return cell.v === undefined ? null : String(cell.v);
    case 'b':
      return !!cell.v;
    case 'e':
      return ERRORS[cell.v] || cell.w || '#ERROR';
    case 'd': {
      const d = cell.v instanceof Date ? cell.v : new Date(cell.v);
      if (Number.isNaN(d.getTime())) return null;
      const iso = d.toISOString();
      return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19);
    }
    default:
      return cell.v === undefined ? null : cell.v;
  }
}

// The used part of a sheet as an array of rows with JSON values. Trailing
// empty rows and columns are removed. Merged cells keep their value only in
// the top-left cell, as in the file.
export function sheetRows(XLSX, wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) throw new ConvertError('excel.noSuchSheet', { name });
  const date1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
  const data = ws['!data'] || [];
  if (!ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows = [];
  let width = 0;
  let lastRow = -1;
  for (let r = range.s.r; r <= range.e.r; r++) {
    const src = data[r] || [];
    const row = [];
    let w = 0;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const v = cellValue(XLSX, src[c], date1904);
      row.push(v);
      if (v !== null && v !== '') w = c - range.s.c + 1;
    }
    row.length = w;
    if (w > width) width = w;
    if (w > 0) lastRow = rows.length;
    rows.push(row);
  }
  rows.length = lastRow + 1;
  for (const row of rows) while (row.length < width) row.push(null);
  return rows;
}

// Sheet rows -> header list and records (objects keyed by header).
export function rowsToRecords(rows, header = true) {
  if (!rows.length) return { headers: [], records: [] };
  const width = rows[0].length;
  let headers;
  let start;
  if (header) {
    const seen = new Set();
    headers = rows[0].map((h, i) => {
      const base = h === null || String(h).trim() === '' ? 'column_' + (i + 1) : String(h).trim();
      let name = base;
      let k = 2;
      while (seen.has(name)) name = base + '_' + k++;
      seen.add(name);
      return name;
    });
    start = 1;
  } else {
    headers = Array.from({ length: width }, (_, i) => 'column_' + (i + 1));
    start = 0;
  }
  const records = [];
  for (let r = start; r < rows.length; r++) {
    const o = {};
    for (let c = 0; c < width; c++) {
      const k = headers[c];
      if (k === '__proto__') Object.defineProperty(o, k, { value: rows[r][c], enumerable: true, writable: true, configurable: true });
      else o[k] = rows[r][c];
    }
    records.push(o);
  }
  return { headers, records };
}

export function safeSheetName(name) {
  let s = String(name || 'Sheet1').replace(/[\[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '');
  if (s === '' || /^history$/i.test(s)) s = 'Sheet1';
  return s.slice(0, 31);
}

// Build an .xlsx file from rows of SheetJS cells (undefined = empty cell).
// The first row is treated as the header row: it gets an autofilter, and
// column widths follow the first 200 rows.
export function buildXlsx(XLSX, cellRows, opts = {}) {
  const warnings = opts.warnings;
  const nRows = cellRows.length;
  if (nRows > MAX_ROWS) throw new ConvertError('excel.tooManyRows', { rows: nRows, max: MAX_ROWS });
  let width = 0;
  for (const r of cellRows) if (r.length > width) width = r.length;
  if (width > MAX_COLS) throw new ConvertError('excel.tooManyCols', { cols: width, max: MAX_COLS });
  if (nRows === 0 || width === 0) throw new ConvertError('general.noData');
  const widths = new Array(width).fill(8);
  for (let r = 0; r < nRows; r++) {
    const row = cellRows[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell) continue;
      if (cell.t === 's' && cell.v.length > MAX_CELL_TEXT) {
        if (warnings) warnings.add('excel.cellTruncated', { cell: cellRef(r, c), length: cell.v.length, max: MAX_CELL_TEXT });
        const cut = cell.v.charCodeAt(MAX_CELL_TEXT - 1);
        cell.v = cell.v.slice(0, cut >= 0xd800 && cut <= 0xdbff ? MAX_CELL_TEXT - 1 : MAX_CELL_TEXT);
      }
      if (r < 200) {
        const len = cell.t === 's' ? cell.v.length : cell.z ? cell.z.length : String(cell.v).length;
        if (len + 2 > widths[c]) widths[c] = Math.min(len + 2, 60);
      }
    }
  }
  const ws = {
    '!data': cellRows,
    '!ref': XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: nRows - 1, c: width - 1 } }),
    '!cols': widths.map((w) => ({ wch: w })),
  };
  if (opts.header !== false && nRows > 1) {
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: nRows - 1, c: width - 1 } }) };
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(opts.sheetName));
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true });
  return new Uint8Array(out);
}
