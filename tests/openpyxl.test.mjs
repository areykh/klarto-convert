// Reads the generated .xlsx files with openpyxl, an XLSX reader that shares
// no code with SheetJS. Skipped (not passed) when Python or openpyxl is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as XLSX from '../src/vendor/sheetjs-0.20.3/xlsx.mjs';
import { TOOLS } from '../src/js/convert/tools.js';
import { sampleText } from '../src/js/samples.js';

const probe = spawnSync('python3', ['-I', '-c', 'import openpyxl'], { encoding: 'utf8' });
const skip = probe.status !== 0 ? 'python3 with openpyxl not available' : false;

const READER = `
import json, sys, openpyxl
out = {}
for path in sys.argv[1:]:
    wb = openpyxl.load_workbook(path)
    ws = wb.worksheets[0]
    rows = []
    for row in ws.iter_rows():
        rows.append([[c.value if not hasattr(c.value, 'isoformat') else c.value.isoformat(), c.number_format, c.is_date] for c in row])
    out[path] = {'sheet': ws.title, 'filter': ws.auto_filter.ref, 'rows': rows, 'widthA': ws.column_dimensions['A'].width}
print(json.dumps(out))
`;

test('openpyxl reads the Excel files of all three Excel tools', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'klarto-openpyxl-'));
  try {
    const ctx = { XLSX, progress: () => {} };
    const files = {};
    for (const [id, kind, lang] of [['xml-to-excel', 'xml', 'en'], ['json-to-excel', 'json', 'en'], ['csv-to-excel', 'csv', 'de']]) {
      const t = TOOLS[id];
      const r = t.convert(t.parse({ text: sampleText(kind, lang) }, {}, ctx), {}, ctx);
      files[id] = join(dir, id + '.xlsx');
      writeFileSync(files[id], r.bytes);
    }
    const p = spawnSync('python3', ['-I', '-c', READER, ...Object.values(files)], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    const res = JSON.parse(p.stdout);
    const csv = res[files['csv-to-excel']];
    assert.equal(csv.filter, 'A1:F4');
    assert.deepEqual(csv.rows[0].map((c) => c[0]), ['id', 'name', 'city', 'amount', 'date', 'note']);
    assert.deepEqual(csv.rows[1].slice(0, 4).map((c) => c[0]), [1001, 'Anna Schmidt', 'Köln', 24.9]);
    assert.equal(csv.rows[1][4][0], '2026-11-02T00:00:00', 'a real date cell');
    assert.equal(csv.rows[1][4][2], true, 'is_date');
    assert.equal(csv.rows[3][5][0], 'Two lines:\nsecond line');
    assert.ok(csv.widthA > 0);
    const xml = res[files['xml-to-excel']];
    assert.equal(xml.sheet, 'order');
    assert.equal(xml.rows[2][xml.rows[0].findIndex((c) => c[0] === 'customer.city')][0], 'Київ');
    const json = res[files['json-to-excel']];
    const h = json.rows[0].map((c) => c[0]);
    assert.equal(json.rows[1][h.indexOf('paid')][0], true);
    assert.equal(json.rows[2][h.indexOf('note')][0], null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
