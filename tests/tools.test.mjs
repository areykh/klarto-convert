// End-to-end tests of the ten tools as the page's worker runs them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '../src/vendor/sheetjs-0.20.3/xlsx.mjs';
import { TOOLS, buildSampleWorkbook } from '../src/js/convert/tools.js';
import { sampleText, SHEET_SAMPLE } from '../src/js/samples.js';
import { xmlToJson } from '../src/js/convert/xml-json.js';
import { parseCsvRows } from '../src/js/convert/csv.js';

const ctx = { XLSX, progress: () => {} };
const enc = new TextEncoder();

function run(id, input, opts = {}) {
  const tool = TOOLS[id];
  const parsed = tool.parse(input, opts, ctx);
  return tool.convert(parsed, opts, ctx);
}
const text = (r) => r.parts.join('');
const err = (fn) => {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected an error');
};
const readXlsx = (bytes) => {
  const wb = XLSX.read(bytes, { type: 'array', cellNF: true });
  return { wb, rows: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null }) };
};

test('there are exactly ten tools', () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), ['csv-to-excel', 'csv-to-json', 'excel-to-json', 'excel-to-xml', 'json-to-csv', 'json-to-excel', 'json-to-xml', 'xml-to-excel', 'xml-to-json', 'xml-validator']);
});

test('xml-to-json: sample, file bytes with BOM, consistent arrays, force arrays', () => {
  const r = run('xml-to-json', { text: sampleText('xml') });
  const j = JSON.parse(text(r));
  assert.equal(j.orders.order.length, 2);
  assert.ok(Array.isArray(j.orders.order[1].item), 'item repeats in order 1001, so it is an array in 1002 too');
  assert.equal(j.orders.order[0].note, 'Leave at the door & ring twice');
  assert.equal(j.orders.order[1].customer.city, 'Київ');
  const plain = JSON.parse(text(run('xml-to-json', { text: sampleText('xml') }, { consistent: false })));
  assert.equal(Array.isArray(plain.orders.order[1].item), false);
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('<r><a>Ü</a></r>')]);
  assert.equal(text(run('xml-to-json', { bytes }, { indent: '0' })), '{"r":{"a":"Ü"}}');
  assert.equal(text(run('xml-to-json', { text: '<r><a>1</a></r>' }, { indent: '0', forceArrays: 'a' })), '{"r":{"a":["1"]}}');
  assert.equal(err(() => run('xml-to-json', { text: '<r>' })).code, 'xml.unclosedTag');
});

test('json-to-xml: sample and options', () => {
  const r = run('json-to-xml', { text: sampleText('json') }, { rootName: 'shop' });
  const xml = text(r);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<shop>'));
  assert.ok(r.warnings.some((w) => w.code === 'json.wrappedInRoot'));
  assert.equal(xmlToJson(xml).json.shop.orders.length, 2);
  assert.equal(text(run('json-to-xml', { text: '{"a":{"b":1}}' }, { indent: '0', declaration: false })), '<a><b>1</b></a>');
  assert.equal(err(() => run('json-to-xml', { text: '{"a":1,}' })).code, 'json.trailingComma');
});

test('xml-to-excel: one row per record, numbers and dates detected, columns aligned', () => {
  const r = run('xml-to-excel', { text: sampleText('xml') });
  assert.equal(r.kind, 'xlsx');
  assert.deepEqual(r.choices.records.map((c) => [c.path.join('.'), c.count]), [['orders.order', 2], ['orders.order.0.item', 2]].slice(0, r.choices.records.length));
  const { rows } = readXlsx(r.bytes);
  const h = rows[0];
  assert.deepEqual(h.slice(0, 6), ['@id', '@date', 'customer.name', 'customer.city', 'item.0.@sku', 'item.0.@qty']);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][h.indexOf('@id')], 1001);
  assert.equal(rows[2][h.indexOf('item.0.@sku')], 'C-88', 'single item lands in the item.0 columns');
  assert.equal(rows[1][h.indexOf('total.#text')], 24.9);
  assert.equal(r.preview[1][h.indexOf('@date')], '2026-11-02');
  const raw = run('xml-to-excel', { text: sampleText('xml') }, { detect: false });
  const rr = readXlsx(raw.bytes).rows;
  assert.equal(rr[1][rr[0].indexOf('@id')], '1001');
});

test('excel-to-xml and excel-to-json: sheets, types, header option, nested', () => {
  const bytes = buildSampleWorkbook(XLSX, SHEET_SAMPLE);
  const x = run('excel-to-xml', { bytes });
  assert.deepEqual(x.choices.sheets.map((s) => s.name), ['Orders', 'Notes']);
  const doc = xmlToJson(text(x)).json;
  assert.equal(doc.rows.row.length, 3);
  assert.deepEqual(doc.rows.row[1], { id: '1002', name: 'Олена Коваль', zip: '01001', amount: '7.5', date: '2026-11-05', paid: 'false' });
  const notes = xmlToJson(text(run('excel-to-xml', { bytes }, { sheet: 'Notes', rootName: 'notes', rowName: 'note' }))).json;
  assert.equal(notes.notes.note.note, 'A second sheet: choose it in the list above the result.');
  const j = JSON.parse(text(run('excel-to-json', { bytes })));
  assert.deepEqual(j[0], { id: 1001, name: 'Anna Schmidt', zip: '50667', amount: 24.9, date: '2026-11-02', paid: true });
  const arr = JSON.parse(text(run('excel-to-json', { bytes }, { header: false })));
  assert.deepEqual(arr[0], ['id', 'name', 'zip', 'amount', 'date', 'paid']);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['user.name', 'user.tags.0', 'user.tags.1', '@id'], ['A', 'x', 'y', 7]]), 'S');
  const nb = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  assert.deepEqual(JSON.parse(text(run('excel-to-json', { bytes: nb }, { nested: true }))), [{ user: { name: 'A', tags: ['x', 'y'] }, '@id': 7 }]);
  assert.equal(text(run('excel-to-xml', { bytes: nb }, { nested: true, indent: '0' })), '<?xml version="1.0" encoding="UTF-8"?><rows><row id="7"><user><name>A</name><tags>x</tags><tags>y</tags></user></row></rows>');
  assert.equal(err(() => run('excel-to-json', { bytes: enc.encode('a,b') })).code, 'excel.notWorkbook');
});

test('json-to-csv: array rule, delimiter, decimal comma, BOM, JSON Lines', () => {
  const r = run('json-to-csv', { text: sampleText('json') }, { bom: false });
  const lines = text(r).split('\r\n');
  assert.equal(lines[0], 'id,date,customer.name,customer.city,items.0.sku,items.0.qty,items.1.sku,items.1.qty,total,paid,note');
  assert.equal(lines[1], '1001,2026-11-02,Anna Schmidt,Köln,A-17,2,B-03,1,24.9,true,"Leave at the door, ring twice"');
  assert.equal(lines[2], '1002,2026-11-05,Олена Коваль,Київ,C-88,3,,,7.5,false,');
  const eu = text(run('json-to-csv', { text: sampleText('json') }, { delimiter: 'semicolon', decimal: ',' }));
  assert.ok(eu.startsWith('\uFEFFid;date;'));
  assert.ok(eu.includes(';24,9;true;Leave at the door, ring twice\r\n'));
  const jl = run('json-to-csv', { text: '{"a":1}\n{"a":2,"b":"x"}\n' }, { bom: false });
  assert.equal(text(jl), 'a,b\r\n1,\r\n2,x\r\n');
  assert.equal(jl.info[0].code, 'info.jsonLines');
  assert.equal(text(run('json-to-csv', { text: '[1,"two",null]' }, { bom: false })), 'value\r\n1\r\ntwo\r\n""\r\n');
});

test('csv-to-json: auto delimiter, types, decimal comma, header off, nested, field count warning', () => {
  const en = JSON.parse(text(run('csv-to-json', { text: sampleText('csv', 'en') })));
  assert.equal(en.length, 3);
  assert.deepEqual(en[0], { id: 1001, name: 'Anna Schmidt', city: 'Köln', amount: 24.9, date: '2026-11-02', note: 'Leave at the door, ring twice' });
  assert.equal(en[2].note, 'Two lines:\nsecond line');
  const de = run('csv-to-json', { text: sampleText('csv', 'de') });
  assert.deepEqual(de.info[0], { code: 'info.delimiter', params: { name: 'semicolon' } });
  assert.equal(JSON.parse(text(de))[0].amount, 24.9);
  assert.equal(JSON.parse(text(run('csv-to-json', { text: 'zip,n\n007,1.50\n' }, { types: false })))[0].zip, '007');
  assert.deepEqual(JSON.parse(text(run('csv-to-json', { text: 'zip,ok\n007,true\n' })))[0], { zip: '007', ok: true });
  assert.deepEqual(JSON.parse(text(run('csv-to-json', { text: 'a,b\n1,2\n' }, { header: false }))), [[ 'a', 'b' ], [1, 2]]);
  assert.deepEqual(JSON.parse(text(run('csv-to-json', { text: 'u.name,u.tags.0\nA,x\n' }, { nested: true }))), [{ u: { name: 'A', tags: ['x'] } }]);
  const w = run('csv-to-json', { text: 'a,b\n1,2,3\n4\n' });
  assert.deepEqual(JSON.parse(text(w)), [{ a: 1, b: 2, column_3: 3 }, { a: 4, b: '', column_3: '' }]);
  assert.equal(w.warnings[0].code, 'csv.fieldCount');
  assert.equal(text(run('csv-to-json', { text: 'a\n' })), '[]\n');
  assert.equal(text(run('csv-to-json', { text: 'a,b\n1,2\n' }, { indent: '0' })), '[{"a":1,"b":2}]');
  const latin = run('csv-to-json', { bytes: new Uint8Array([0x61, 0x0a, 0x4b, 0xe4, 0x73, 0x65, 0x0a]) });
  assert.deepEqual(JSON.parse(text(latin)), [{ a: 'Käse' }]);
  assert.ok(latin.info.some((i) => i.code === 'decode.readAs1252'));
});

test('json-to-excel: types kept, ISO dates, rows choice', () => {
  const r = run('json-to-excel', { text: sampleText('json') });
  const { wb, rows } = readXlsx(r.bytes);
  assert.deepEqual(wb.SheetNames, ['orders']);
  assert.equal(rows[1][0], 1001);
  const ws = wb.Sheets.orders;
  assert.equal(ws.B2.t, 'n');
  assert.equal(ws.B2.z, 'yyyy-mm-dd');
  assert.equal(rows[1][rows[0].indexOf('paid')], true);
  const s = run('json-to-excel', { text: '[{"zip":"01067","n":"5"}]' });
  const sr = readXlsx(s.bytes).rows;
  assert.deepEqual(sr[1], ['01067', '5'], 'JSON strings stay text in Excel');
});

test('csv-to-excel: detection, decimal comma, zip codes as text, header autofilter', () => {
  const r = run('csv-to-excel', { text: sampleText('csv', 'de') });
  const { wb, rows } = readXlsx(r.bytes);
  const ws = wb.Sheets.Sheet1;
  assert.equal(rows[1][3], 24.9);
  assert.equal(ws.E2.z, 'yyyy-mm-dd');
  assert.equal(ws['!autofilter'].ref, 'A1:F4');
  const z = readXlsx(run('csv-to-excel', { text: 'zip;phone;iban;n\n01067;+4930123;DE89370400440532013000;1.234,5\n' }).bytes).rows;
  assert.deepEqual(z[1], ['01067', '+4930123', 'DE89370400440532013000', '1.234,5'], 'no thousands separators');
  const raw = readXlsx(run('csv-to-excel', { text: 'a,b\n1,2\n' }, { detect: false }).bytes).rows;
  assert.deepEqual(raw[1], ['1', '2']);
});

test('xml-validator: valid report and error report', () => {
  const ok = run('xml-validator', { text: sampleText('xml') });
  assert.equal(ok.valid, true);
  assert.equal(ok.stats.root, 'orders');
  const bad = run('xml-validator', { text: sampleText('xml-broken') });
  assert.equal(bad.valid, false);
  assert.deepEqual([bad.error.code, bad.error.params.line, bad.error.params.col], ['xml.bareAmpersand', 4, 21]);
});

test('round trip CSV -> JSON -> CSV', () => {
  const csv = 'id,name,note\r\n1,"Doe, Jane","say ""hi"""\r\n2,Ünï,"two\nlines"\r\n';
  const json = text(run('csv-to-json', { text: csv }, { types: false }));
  assert.equal(text(run('json-to-csv', { text: json }, { bom: false })), csv);
});

test('round trip JSON -> CSV -> JSON (nested) and JSON -> Excel -> JSON', () => {
  const v = [{ id: 1, user: { name: 'A', roles: ['x', 'y'] }, ok: true }, { id: 2, user: { name: 'B', roles: ['z', 'w'] }, ok: false }];
  const csv = text(run('json-to-csv', { text: JSON.stringify(v) }));
  assert.deepEqual(JSON.parse(text(run('csv-to-json', { text: csv }, { nested: true }))), v);
  const x = run('json-to-excel', { text: JSON.stringify(v) });
  assert.deepEqual(JSON.parse(text(run('excel-to-json', { bytes: x.bytes }, { nested: true }))), v);
});

test('round trip XML -> Excel -> XML keeps attributes and text', () => {
  const xml = '<list><item id="1"><name>A</name></item><item id="2"><name>B</name></item></list>';
  const x = run('xml-to-excel', { text: xml }, { detect: false });
  const back = xmlToJson(text(run('excel-to-xml', { bytes: x.bytes }, { rootName: 'list', rowName: 'item' }))).json;
  assert.deepEqual(back, xmlToJson(xml).json);
});

test('CSV -> Excel -> JSON keeps quotes, line breaks and Unicode', () => {
  const x = run('csv-to-excel', { text: sampleText('csv', 'en') });
  const j = JSON.parse(text(run('excel-to-json', { bytes: x.bytes })));
  assert.equal(j[2].name, "O'Brien, Liam");
  assert.equal(j[2].note, 'Two lines:\nsecond line');
  assert.equal(j[1].city, 'Київ');
  assert.equal(j[0].date, '2026-11-02');
  const rows = parseCsvRows(sampleText('csv', 'en')).rows;
  assert.equal(j.length, rows.length - 1);
});

test('review fixes: empty values survive a CSV round trip; clashing headers warn', () => {
  const csv = text(run('json-to-csv', { text: '[{"a":"x"},{"a":""},{"a":"y"}]' }, { bom: false }));
  assert.equal(csv, 'a\r\nx\r\n""\r\ny\r\n');
  assert.deepEqual(JSON.parse(text(run('csv-to-json', { text: csv }))), [{ a: 'x' }, { a: '' }, { a: 'y' }]);
  const r = run('json-to-csv', { text: '[{"a.b":1,"a":{"b":2}}]' }, { bom: false });
  assert.equal(text(r), 'a.b\r\n1\r\n');
  assert.equal(r.warnings[0].code, 'flatten.headerClash');
});

test('review fixes: no silent thousands scaling between JSON -> CSV and CSV -> JSON', () => {
  const csv = text(run('json-to-csv', { text: '[{"a":1.234,"b":12.5}]' }, { delimiter: 'semicolon', decimal: '.', bom: false }));
  assert.equal(csv, 'a;b\r\n1.234;12.5\r\n');
  assert.deepEqual(JSON.parse(text(run('csv-to-json', { text: csv }))), [{ a: '1.234', b: '12.5' }], 'auto decimal is a comma for ";": dot values stay text');
  assert.deepEqual(JSON.parse(text(run('csv-to-json', { text: csv }, { decimal: '.' }))), [{ a: 1.234, b: 12.5 }]);
  assert.deepEqual(JSON.parse(text(run('csv-to-json', { text: 'n\n"1,234"\n' }))), [{ n: '1,234' }]);
});

test('review fixes: CSV in UTF-16 without a byte order mark', () => {
  const s = 'a;b\nÄ;1\n';
  const le = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { le[2 * i] = s.charCodeAt(i) & 255; le[2 * i + 1] = s.charCodeAt(i) >> 8; }
  const r = run('csv-to-json', { bytes: le });
  assert.deepEqual(JSON.parse(text(r)), [{ a: 'Ä', b: 1 }]);
  assert.ok(r.info.some((i) => i.code === 'info.encoding' && i.params.encoding === 'UTF-16LE'));
});
