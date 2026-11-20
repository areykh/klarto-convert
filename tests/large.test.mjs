// Large inputs generated in memory: a 50 MB CSV and a 20 MB XML.
// Prints the conversion times (node --test shows them as diagnostics) and
// checks that nothing was lost. Set LARGE=0 to skip, e.g. on a slow machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '../src/vendor/sheetjs-0.20.3/xlsx.mjs';
import { TOOLS } from '../src/js/convert/tools.js';

const skip = process.env.LARGE === '0';
const ctx = { XLSX, progress: () => {} };
const MB = 1024 * 1024;

function run(id, input, opts = {}) {
  const tool = TOOLS[id];
  return tool.convert(tool.parse(input, opts, ctx), opts, ctx);
}

function makeCsv(targetBytes) {
  const parts = ['id,name,city,amount,date,note\n'];
  let size = parts[0].length;
  let i = 0;
  const cities = ['Köln', 'Київ', 'Zürich', 'São Paulo', 'Łódź'];
  while (size < targetBytes) {
    const line = `${i},"Customer ${i}, Ltd",${cities[i % 5]},${(i % 1000) + 0.25},2026-11-${String((i % 28) + 1).padStart(2, '0')},"note with ""quotes"" ${i}"\n`;
    parts.push(line);
    size += Buffer.byteLength(line);
    i++;
  }
  return { text: parts.join(''), rows: i };
}

function makeXml(targetBytes) {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<orders xmlns:p="urn:p">\n'];
  let size = parts[0].length;
  let i = 0;
  while (size < targetBytes) {
    const rec = `  <order id="${i}"><customer>Анна ${i}</customer><item sku="A${i % 97}" qty="2">Pen &amp; ink</item><item sku="B">Pad</item><p:total currency="EUR">${i}.50</p:total><note><![CDATA[x < y]]></note></order>\n`;
    parts.push(rec);
    size += Buffer.byteLength(rec);
    i++;
  }
  parts.push('</orders>\n');
  return { text: parts.join(''), records: i };
}

const timed = (fn) => {
  const t0 = process.hrtime.bigint();
  const r = fn();
  return { r, s: Number(process.hrtime.bigint() - t0) / 1e9 };
};

test('50 MB CSV -> JSON', { skip }, (t) => {
  const { text, rows } = makeCsv(50 * MB);
  const bytes = Buffer.byteLength(text);
  const { r, s } = timed(() => run('csv-to-json', { text }));
  let outBytes = 0;
  for (const p of r.parts) outBytes += Buffer.byteLength(p);
  t.diagnostic(`csv-to-json: ${(bytes / MB).toFixed(1)} MB, ${rows} rows -> ${(outBytes / MB).toFixed(1)} MB JSON in ${s.toFixed(2)} s`);
  assert.equal(r.info.find((i) => i.code === 'info.records').params.count, rows);
  const last = r.parts[r.parts.length - 1];
  assert.ok(last.includes(`"id": ${rows - 1}`));
});

test('50 MB CSV -> Excel', { skip }, (t) => {
  // 611,452 rows: under Excel's limit of 1,048,576 rows per sheet.
  const { text, rows } = makeCsv(50 * MB);
  const { r, s } = timed(() => run('csv-to-excel', { text }));
  t.diagnostic(`csv-to-excel: ${rows} rows -> ${(r.bytes.length / MB).toFixed(1)} MB xlsx in ${s.toFixed(2)} s`);
  assert.equal(r.kind, 'xlsx');
  // Parse only the first row; SheetJS keeps the full sheet range in !fullref.
  const wb = XLSX.read(r.bytes, { type: 'array', dense: true, sheetRows: 1 });
  assert.equal(XLSX.utils.decode_range(wb.Sheets.Sheet1['!fullref']).e.r, rows, 'header + all rows');
});

test('20 MB XML -> JSON and validation', { skip }, (t) => {
  const { text, records } = makeXml(20 * MB);
  const bytes = Buffer.byteLength(text);
  const v = timed(() => run('xml-validator', { text }));
  assert.equal(v.r.valid, true);
  const { r, s } = timed(() => run('xml-to-json', { text }));
  const out = r.parts.join('');
  t.diagnostic(`xml-validator: ${(bytes / MB).toFixed(1)} MB in ${v.s.toFixed(2)} s; xml-to-json: ${records} records -> ${(Buffer.byteLength(out) / MB).toFixed(1)} MB JSON in ${s.toFixed(2)} s`);
  const j = JSON.parse(out);
  assert.equal(j.orders.order.length, records);
  assert.equal(j.orders.order[records - 1].note, 'x < y');
});

test('20 MB XML -> Excel', { skip }, (t) => {
  const { text, records } = makeXml(20 * MB);
  const { r, s } = timed(() => run('xml-to-excel', { text }));
  t.diagnostic(`xml-to-excel: ${records} records -> ${(r.bytes.length / MB).toFixed(1)} MB xlsx in ${s.toFixed(2)} s`);
  assert.equal(r.kind, 'xlsx');
});
