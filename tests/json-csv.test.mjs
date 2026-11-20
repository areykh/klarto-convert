import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson, findJsonError } from '../src/js/convert/json-parse.js';
import { parseCsvRows, detectDelimiter, uniqueHeaders, csvField, cellText } from '../src/js/convert/csv.js';
import { Warnings } from '../src/js/convert/errors.js';
import { decodeBytes, firstInvalidUtf8 } from '../src/js/convert/decode.js';
import { findArrays, pickRecords, collectHeaders, recordRow, unflatten, flattenRecord } from '../src/js/convert/flatten.js';

const err = (fn) => {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected an error');
};

// ------------------------------------------------------------------ JSON

test('JSON errors: code, line, column', () => {
  const cases = [
    ['{"a": 1,}', 'json.trailingComma', 1, 9],
    ['[1, 2,]', 'json.trailingComma', 1, 7],
    ['{"a": 1 "b": 2}', 'json.missingComma', 1, 9],
    ['[1 2]', 'json.missingComma', 1, 4],
    ['{"a" 1}', 'json.missingColon', 1, 6],
    ["{'a': 1}", 'json.singleQuote', 1, 2],
    ['{a: 1}', 'json.keyNotString', 1, 2],
    ['{"a": "x\n"}', 'json.newlineInString', 1, 9],
    ['{"a": "x\\q"}', 'json.badEscape', 1, 9],
    ['{"a": "abc', 'json.unterminatedString', 1, 7],
    ['{"a": 01}', 'json.badNumber', 1, 7],
    ['{"a": .5}', 'json.badNumber', 1, 7],
    ['{"a": NaN}', 'json.badLiteral', 1, 7],
    ['{"a": True}', 'json.badLiteral', 1, 7],
    ['{"a": undefined}', 'json.badLiteral', 1, 7],
    ['{\n  // comment\n  "a": 1\n}', 'json.comment', 2, 3],
    ['{"a": 1} {"b": 2}', 'json.extraData', 1, 10],
    ['{"a": [1, 2', 'json.unexpectedEnd', 1, 12],
    ['{"a":', 'json.unexpectedEnd', 1, 6],
    ['{"a": #}', 'json.unexpectedChar', 1, 7],
    ['{\n  "name": "x",\n  "list": [1, 2,]\n}', 'json.trailingComma', 3, 17],
  ];
  for (const [s, code, line, col] of cases) {
    const e = err(() => parseJson(s));
    assert.equal(e.code, code, JSON.stringify(s) + ' -> ' + e.message);
    assert.deepEqual([e.params.line, e.params.col], [line, col], JSON.stringify(s));
  }
});

test('the scanner accepts everything JSON.parse accepts (sample)', () => {
  for (const s of ['0', '-0.5e+10', '"\\u00e9\\n"', '[]', '{}', '{"a":[{"b":null}],"c":true,"d":false}', ' \n[1,\t2]\r\n', '"\ud800"']) {
    assert.equal(findJsonError(s), null, s);
    assert.doesNotThrow(() => JSON.parse(s));
  }
});

test('JSON: BOM, empty input, JSON Lines', () => {
  assert.deepEqual(parseJson('\uFEFF{"a":1}').value, { a: 1 });
  assert.equal(err(() => parseJson('  \n')).code, 'input.empty');
  const r = parseJson('{"a":1}\n{"a":2}\n\n{"a":3}\n', { jsonLines: true });
  assert.equal(r.jsonLines, true);
  assert.deepEqual(r.value, [{ a: 1 }, { a: 2 }, { a: 3 }]);
  const e = err(() => parseJson('{"a":1}\n{"a":2,}\n', { jsonLines: true }));
  assert.equal(e.code, 'json.trailingComma');
  assert.equal(e.params.line, 2);
  assert.equal(err(() => parseJson('{"a":1}\n{"a":2}')).code, 'json.extraData');
});

// ------------------------------------------------------------------ CSV

test('CSV: delimiter detection', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3\n'), ',');
  assert.equal(detectDelimiter('Name;Preis;Ort\nKäse;1,50;Köln\nBrot;2,10;Bonn\n'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2\n'), '\t');
  assert.equal(detectDelimiter('a|b|c\n1|2|3\n'), '|');
  assert.equal(detectDelimiter('"x, y";b\n"1,5";2\n"3,1";4\n'), ';');
  assert.equal(detectDelimiter('just one column\nvalue\n'), ',');
  assert.equal(detectDelimiter('a;b,c\n1;2,3\n4;5,6,7\n'), ';');
});

test('CSV: quotes, delimiters and line breaks inside fields; line endings', () => {
  const csv = 'id,text,n\r\n1,"Hello, ""world""",2\r\n2,"line1\nline2\r\nline3",3\r4,,\n';
  assert.deepEqual(parseCsvRows(csv).rows, [
    ['id', 'text', 'n'],
    ['1', 'Hello, "world"', '2'],
    ['2', 'line1\nline2\r\nline3', '3'],
    ['4', '', ''],
  ]);
});

test('CSV: a line with "" is a row with one empty field', () => {
  assert.deepEqual(parseCsvRows('a\n""\n\nb\n').rows, [['a'], [''], ['b']]);
});

test('CSV: empty lines skipped, trailing delimiter, BOM, unquoted quotes', () => {
  assert.deepEqual(parseCsvRows('\uFEFFa;b\n\n1;\n\n2;x"y\n', { delimiter: ';' }).rows, [['a', 'b'], ['1', ''], ['2', 'x"y']]);
});

test('CSV: an unclosed quote is an error with the line where it starts', () => {
  const e = err(() => parseCsvRows('a,b\n1,2\n3,"open\nmore\n'));
  assert.equal(e.code, 'csv.unclosedQuote');
  assert.equal(e.params.line, 3);
});

test('CSV: text after a closing quote is kept, with a warning', () => {
  const w = new Warnings();
  assert.deepEqual(parseCsvRows('"ab"c,d\n', { warnings: w }).rows, [['abc', 'd']]);
  assert.equal(w.list()[0].code, 'csv.textAfterQuote');
});

test('CSV: header names are made unique and non-empty', () => {
  assert.deepEqual(uniqueHeaders(['a', '', 'a', 'a', ' ']), ['a', 'column_2', 'a_2', 'a_3', 'column_5']);
});

test('CSV: writing quotes only when needed, round trip', () => {
  assert.equal(csvField('plain', ','), 'plain');
  assert.equal(csvField('a,b', ','), '"a,b"');
  assert.equal(csvField('a,b', ';'), 'a,b');
  assert.equal(csvField('say "hi"', ','), '"say ""hi"""');
  assert.equal(csvField('two\nlines', ';'), '"two\nlines"');
  const rows = [['a', 'b,c', 'd"e'], ['multi\nline', '', ' space '], ['x;y', '\t', '😀']];
  for (const d of [',', ';', '\t']) {
    const text = rows.map((r) => r.map((f) => csvField(f, d)).join(d)).join('\r\n') + '\r\n';
    assert.deepEqual(parseCsvRows(text, { delimiter: d }).rows, rows, 'delimiter ' + JSON.stringify(d));
  }
});

test('CSV: number cells and decimal comma', () => {
  assert.equal(cellText(1.5, true), '1,5');
  assert.equal(cellText(1.5, false), '1.5');
  assert.equal(cellText(true, false), 'true');
  assert.equal(cellText(null, false), '');
});

// ------------------------------------------------------------------ decode

test('decode: BOMs, declared XML encoding, invalid UTF-8', () => {
  const enc = new TextEncoder();
  assert.deepEqual(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('ä')]), 'csv'), { text: 'ä', encoding: 'UTF-8', bom: true });
  assert.equal(decodeBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x04, 0x04]), 'xml').text, 'AЄ');
  assert.equal(decodeBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x41]), 'json').text, 'A');
  const latin1 = new Uint8Array([...enc.encode('<?xml version="1.0" encoding="ISO-8859-1"?><a>'), 0xe4, ...enc.encode('</a>')]);
  const d = decodeBytes(latin1, 'xml');
  assert.equal(d.text.slice(-5), 'ä</a>');
  assert.equal(d.encoding, 'WINDOWS-1252');
  const bad = new Uint8Array([...enc.encode('<a>\nx\n'), 0xe4, ...enc.encode('</a>')]);
  const e = err(() => decodeBytes(bad, 'xml'));
  assert.equal(e.code, 'decode.invalidUtf8Xml');
  assert.equal(e.params.line, 3);
  const csv = decodeBytes(new Uint8Array([0x4b, 0xe4, 0x73, 0x65]), 'csv');
  assert.equal(csv.text, 'Käse');
  assert.equal(csv.notice, 'decode.readAs1252');
  assert.equal(err(() => decodeBytes(new Uint8Array([]), 'csv')).code, 'input.empty');
  assert.equal(err(() => decodeBytes(enc.encode('<?xml version="1.0" encoding="x-nope"?><a/>'), 'xml')).code, 'decode.unknownEncoding');
});

test('decode: UTF-8 validator finds the first bad byte', () => {
  const enc = new TextEncoder();
  assert.equal(firstInvalidUtf8(enc.encode('aé漢😀')), -1);
  assert.equal(firstInvalidUtf8(new Uint8Array([0x61, 0xc3])), 1);
  assert.equal(firstInvalidUtf8(new Uint8Array([0x61, 0xc0, 0x80])), 1);
  assert.equal(firstInvalidUtf8(new Uint8Array([0xed, 0xa0, 0x80])), 0);
});

// ------------------------------------------------------------------ flatten

test('flatten: dotted headers, numbered arrays, empty containers, order', () => {
  const recs = [
    { id: 1, customer: { name: 'Anna', address: { city: 'Köln' } }, tags: ['a', 'b'], items: [{ sku: 'X', qty: 2 }, { sku: 'Y', qty: 1 }], extra: {}, none: [] },
    { id: 2, customer: { name: 'Ben' }, tags: ['c'], note: 'only here' },
  ];
  const { headers, index } = collectHeaders(recs);
  assert.deepEqual(headers, ['id', 'customer.name', 'customer.address.city', 'tags.0', 'tags.1', 'items.0.sku', 'items.0.qty', 'items.1.sku', 'items.1.qty', 'extra', 'none', 'note']);
  assert.deepEqual(Array.from(recordRow(recs[1], index, headers.length)), [2, 'Ben', undefined, 'c', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'only here']);
  const out = [];
  flattenRecord('plain', (h, v) => out.push([h, v]));
  assert.deepEqual(out, [['value', 'plain']]);
});

test('flatten: which array becomes the rows', () => {
  assert.equal(pickRecords([{ a: 1 }, { a: 2 }]).records.length, 2);
  const doc = { meta: { tags: ['x', 'y', 'z', 'w'] }, data: { orders: [{ id: 1 }, { id: 2 }] } };
  const p = pickRecords(doc);
  assert.deepEqual(p.chosen.path, ['data', 'orders']);
  assert.deepEqual(p.choices.map((c) => c.path.join('.')), ['data.orders', 'meta.tags']);
  assert.deepEqual(pickRecords(doc, JSON.stringify(['meta', 'tags'])).records, ['x', 'y', 'z', 'w']);
  assert.deepEqual(pickRecords(doc, 'whole').records, [doc]);
  assert.deepEqual(pickRecords({ name: 'x', tags: ['a', 'b'] }).records, [{ name: 'x', tags: ['a', 'b'] }], 'arrays of plain values do not become rows by default');
  assert.equal(findArrays({ a: [[1], [2]] })[0].count, 2);
});

test('unflatten rebuilds nesting and arrays', () => {
  assert.deepEqual(unflatten({ id: '1', 'customer.name': 'Anna', 'tags.0': 'a', 'tags.1': 'b', 'items.0.sku': 'X', 'items.1.sku': 'Y' }), {
    id: '1', customer: { name: 'Anna' }, tags: ['a', 'b'], items: [{ sku: 'X' }, { sku: 'Y' }],
  });
  assert.deepEqual(unflatten({ 'a.0': 1, 'a.2': 3 }), { a: { 0: 1, 2: 3 } }, 'gaps keep an object');
  assert.deepEqual(unflatten({ a: 1, 'a.b': 2 }), { a: 1, 'a.b': 2 }, 'clash keeps the flat name');
  assert.deepEqual(unflatten({ 'a.b': 2, a: 1 }), { 'a.b': 2, a: 1 }, 'in any order');
  assert.deepEqual(unflatten({ 'a.b.c': 3, 'a.b': 2, x: 1 }), { 'a.b.c': 3, a: { b: 2 }, x: 1 });
  assert.deepEqual(unflatten({ 'x.': 1, '.y': 2 }), { 'x.': 1, '.y': 2 });
  const j = unflatten(JSON.parse('{"__proto__.x": 1}'));
  assert.equal(Object.getPrototypeOf(j), Object.prototype);
});

test('round trip: JSON -> flat -> JSON', () => {
  const recs = [{ id: 1, user: { name: 'A', roles: ['x', 'y'] }, list: [{ k: 1 }, { k: 2 }] }];
  const { headers, index } = collectHeaders(recs);
  const row = recordRow(recs[0], index, headers.length);
  const flat = Object.fromEntries(headers.map((h, i) => [h, row[i]]));
  assert.deepEqual(unflatten(flat), recs[0]);
});
