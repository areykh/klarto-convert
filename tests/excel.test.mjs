import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '../src/vendor/sheetjs-0.20.3/xlsx.mjs';
import { isoToSerial, serialToIso, parseNumber, textCell, jsonCell, cellRef, formatDateCell, MAX_ROWS } from '../src/js/convert/cells.js';
import { readWorkbook, sheetList, sheetRows, rowsToRecords, buildXlsx, safeSheetName, sniffWorkbook } from '../src/js/convert/excel.js';
import { Warnings } from '../src/js/convert/errors.js';

const err = (fn) => {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected an error');
};

test('SheetJS version is the pinned one', () => {
  assert.equal(XLSX.version, '0.20.3');
});

test('ISO date <-> Excel serial, including the 1900 leap-year quirk', () => {
  const cases = [
    ['1900-01-01', 1], ['1900-02-28', 59], ['1900-03-01', 61], ['1970-01-01', 25569],
    ['2000-02-29', 36585], ['2026-11-20', 46346], ['9999-12-31', 2958465],
  ];
  for (const [iso, serial] of cases) {
    assert.equal(isoToSerial(iso).serial, serial, iso);
    assert.equal(serialToIso(serial), iso, String(serial));
    assert.equal(XLSX.SSF.format('yyyy-mm-dd', serial), iso, 'SheetJS agrees for ' + iso);
  }
  assert.equal(serialToIso(60), '1900-02-29');
  const dt = isoToSerial('2026-11-20T13:45:30');
  assert.equal(dt.time, true);
  assert.equal(serialToIso(dt.serial), '2026-11-20T13:45:30');
  assert.equal(XLSX.SSF.format('yyyy-mm-dd hh:mm:ss', dt.serial), '2026-11-20 13:45:30');
  assert.equal(serialToIso(0.5), '12:00:00');
  assert.equal(serialToIso(0, true), '1904-01-01');
  for (const bad of ['2026-02-30', '2026-13-01', '1899-12-31', '2026-1-1', '2026-11-20T25:00', '20.11.2026', '2026-11-20Z', '2026-11-20T10:00:00+02:00']) {
    assert.equal(isoToSerial(bad), null, bad);
  }
});

test('number detection keeps IDs, phone numbers and zip codes as text', () => {
  const dot = [['42', 42], ['-3.5', -3.5], ['0', 0], ['0.25', 0.25], ['1e3', 1000], ['123456789012345', 123456789012345]];
  for (const [s, v] of dot) assert.equal(parseNumber(s, '.'), v, s);
  const comma = [['1,5', 1.5], ['-1234,56', -1234.56], ['1234', 1234], ['0,5', 0.5]];
  for (const [s, v] of comma) assert.equal(parseNumber(s, ','), v, s);
  // no thousands separators: they could be decimal marks, so they stay text
  for (const s of ['007', '+4930123456', '1234567890123456', '1.5.2', '12 345', '1,5', '1,234', '1,234.5', '', ' 1', '1 ', 'NaN', 'Infinity', '0x10', '1.', '.5']) {
    assert.equal(parseNumber(s, '.'), null, s);
  }
  assert.equal(parseNumber('1.5', ','), null);
  assert.equal(parseNumber('1.234', ','), null);
  assert.equal(parseNumber('-1.234,56', ','), null);
  assert.equal(parseNumber('DE89370400440532013000', '.'), null);
});

test('text and JSON values become the right cells', () => {
  assert.deepEqual(textCell('12.5', { detect: true, decimal: '.' }), { t: 'n', v: 12.5 });
  assert.deepEqual(textCell('00123', { detect: true, decimal: '.' }), { t: 's', v: '00123' });
  assert.deepEqual(textCell('2026-11-20', { detect: true }), { t: 'n', v: 46346, z: 'yyyy-mm-dd' });
  assert.deepEqual(textCell('12.5', { detect: false }), { t: 's', v: '12.5' });
  assert.equal(textCell('', { detect: true }), undefined);
  assert.deepEqual(jsonCell('123', { dates: true }), { t: 's', v: '123' }, 'JSON strings stay text');
  assert.deepEqual(jsonCell(123, {}), { t: 'n', v: 123 });
  assert.deepEqual(jsonCell(false, {}), { t: 'b', v: false });
  assert.deepEqual(jsonCell('2026-11-20', { dates: true }).t, 'n');
  assert.deepEqual(jsonCell('2026-11-20', { dates: false }), { t: 's', v: '2026-11-20' });
  assert.equal(cellRef(0, 0), 'A1');
  assert.equal(cellRef(9, 27), 'AB10');
  assert.equal(cellRef(0, 16383), 'XFD1');
});

function sampleWorkbook() {
  const wb = XLSX.utils.book_new();
  const data = XLSX.utils.aoa_to_sheet([
    ['Name', 'Born', 'Zip', 'Amount', 'Active', '', 'Name'],
    ['Олена', { t: 'n', v: 46346, z: 'dd.mm.yyyy' }, '01067', 1234.5, true, null, 'dup'],
    ['李雷', { t: 'n', v: 36585.75, z: 'yyyy-mm-dd hh:mm' }, '10115', { t: 'e', v: 0x07 }, false, null, 'dup2'],
    [],
  ]);
  XLSX.utils.book_append_sheet(wb, data, 'Data');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['only'], [1]]), 'Second');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['h']]), 'Hidden');
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }] };
  return wb;
}

test('reading a workbook: sheets, dates, text numbers, errors, headers', () => {
  const bytes = XLSX.write(sampleWorkbook(), { type: 'array', bookType: 'xlsx' });
  const wb = readWorkbook(XLSX, bytes);
  assert.deepEqual(sheetList(XLSX, wb).map((s) => [s.name, s.rows, s.cols, s.hidden]), [['Data', 3, 7, false], ['Second', 2, 1, false], ['Hidden', 1, 1, true]]);
  const rows = sheetRows(XLSX, wb, 'Data');
  assert.equal(rows.length, 3, 'trailing empty row removed');
  assert.deepEqual(rows[1], ['Олена', '2026-11-20', '01067', 1234.5, true, null, 'dup']);
  assert.deepEqual(rows[2], ['李雷', '2000-02-29T18:00:00', '10115', '#DIV/0!', false, null, 'dup2']);
  const { headers, records } = rowsToRecords(rows, true);
  assert.deepEqual(headers, ['Name', 'Born', 'Zip', 'Amount', 'Active', 'column_6', 'Name_2']);
  assert.equal(records[0].Zip, '01067');
  assert.equal(records[0].column_6, null);
  assert.deepEqual(rowsToRecords(rows, false).headers.slice(0, 2), ['column_1', 'column_2']);
  assert.deepEqual(sheetRows(XLSX, wb, 'Second'), [['only'], [1]]);
  assert.equal(err(() => sheetRows(XLSX, wb, 'Nope')).code, 'excel.noSuchSheet');
});

test('reading .xls and .ods files', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], ['Ünï', 2]]), 'S');
  for (const bookType of ['xls', 'ods', 'xlsb']) {
    const bytes = XLSX.write(wb, { type: 'array', bookType });
    const r = readWorkbook(XLSX, bytes);
    assert.deepEqual(sheetRows(XLSX, r, 'S'), [['a', 'b'], ['Ünï', 2]], bookType);
  }
});

test('non-workbooks and broken files give clear errors', () => {
  assert.equal(err(() => readWorkbook(XLSX, new TextEncoder().encode('a,b\n1,2\n'))).code, 'excel.notWorkbook');
  assert.equal(err(() => readWorkbook(XLSX, new Uint8Array(0))).code, 'input.empty');
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(sniffWorkbook(zip), 'zip');
  assert.equal(err(() => readWorkbook(XLSX, zip)).code, 'excel.unreadable');
  // An encrypted Office file is an OLE container with EncryptionInfo and
  // EncryptedPackage streams (MS-OFFCRYPTO). Build one with SheetJS CFB.
  const cfb = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(cfb, '/EncryptionInfo', new Uint8Array([4, 0, 4, 0, 0x40, 0, 0, 0, ...new Array(200).fill(0)]));
  XLSX.CFB.utils.cfb_add(cfb, '/EncryptedPackage', new Uint8Array(600));
  const enc = XLSX.CFB.write(cfb, { type: 'array' });
  assert.equal(sniffWorkbook(new Uint8Array(enc)), 'ole');
  assert.equal(err(() => readWorkbook(XLSX, enc)).code, 'excel.encrypted');
});

test('writing: types, dates, autofilter, widths, limits', () => {
  const w = new Warnings();
  const rows = [
    [{ t: 's', v: 'name' }, { t: 's', v: 'when' }, { t: 's', v: 'n' }],
    [{ t: 's', v: 'x'.repeat(40000) }, { t: 'n', v: 46346, z: 'yyyy-mm-dd' }, { t: 'n', v: 1.5 }],
    [undefined, undefined, { t: 'b', v: true }],
  ];
  const bytes = buildXlsx(XLSX, rows, { warnings: w, sheetName: 'a/b:c' });
  assert.equal(w.list()[0].code, 'excel.cellTruncated');
  assert.equal(w.list()[0].params.cell, 'A2');
  const wb = XLSX.read(bytes, { type: 'array', cellNF: true });
  assert.deepEqual(wb.SheetNames, ['a_b_c']);
  const ws = wb.Sheets.a_b_c;
  assert.equal(ws.A2.v.length, 32767);
  assert.equal(ws.B2.t, 'n');
  assert.equal(ws.B2.z, 'yyyy-mm-dd');
  assert.equal(ws.C3.v, true);
  assert.equal(ws['!autofilter'].ref, 'A1:C3');
  const big = new Array(MAX_ROWS + 1);
  assert.equal(err(() => buildXlsx(XLSX, big)).code, 'excel.tooManyRows');
  assert.equal(err(() => buildXlsx(XLSX, [])).code, 'general.noData');
  assert.equal(safeSheetName('x'.repeat(40)).length, 31);
  assert.equal(safeSheetName('History'), 'Sheet1');
});

test('workbooks with the 1904 date system give the right dates', () => {
  const wb = XLSX.utils.book_new();
  // 2026-11-20 is serial 44884 in the 1904 system (46346 - 1462).
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['d'], [{ t: 'n', v: 44884, z: 'yyyy-mm-dd' }]]), 'S');
  wb.Workbook = { WBProps: { date1904: true } };
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const r = readWorkbook(XLSX, bytes);
  assert.equal(r.Workbook.WBProps.date1904, true);
  assert.deepEqual(sheetRows(XLSX, r, 'S'), [['d'], ['2026-11-20']]);
});

test('times and elapsed durations follow the number format, in both date systems', () => {
  assert.equal(formatDateCell(0.6041666666666666, 'h:mm'), '14:30:00');
  assert.equal(formatDateCell(0.6041666666666666, 'h:mm', true), '14:30:00');
  assert.equal(formatDateCell(1.5, '[h]:mm:ss'), '36:00:00');
  assert.equal(formatDateCell(46346.5, 'dd/mm/yyyy'), '2026-11-20');
  assert.equal(formatDateCell(46346, 'yyyy-mm-dd hh:mm'), '2026-11-20T00:00:00');
  assert.equal(formatDateCell(46346.25, 'd.m.yyyy h:mm AM/PM'), '2026-11-20T06:00:00');
  assert.equal(formatDateCell(46346, 'mmm yy'), '2026-11-20');
  assert.equal(formatDateCell(0.5, 'mm:ss'), '12:00:00');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['t', 'd'], [{ t: 'n', v: 0.6041666666666666, z: 'hh:mm' }, { t: 'n', v: 1.5, z: '[h]:mm:ss' }]]), 'S');
  wb.Workbook = { WBProps: { date1904: true } };
  const r = readWorkbook(XLSX, XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  assert.deepEqual(sheetRows(XLSX, r, 'S')[1], ['14:30:00', '36:00:00']);
});

test('cutting long text never splits a character', () => {
  const w = new Warnings();
  const v = 'a'.repeat(32766) + '\u{1F600}';
  const bytes = buildXlsx(XLSX, [[{ t: 's', v: 'h' }], [{ t: 's', v }]], { warnings: w });
  const cell = XLSX.read(bytes, { type: 'array' }).Sheets.Sheet1.A2.v;
  assert.equal(cell.length, 32766);
  assert.ok(!/[\uD800-\uDFFF]/.test(cell));
});
